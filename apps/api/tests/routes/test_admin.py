"""Integration tests for /admin/audit-logs (T-A-43) — 実 Postgres + RLS + JWT。

admin (app_metadata.role=admin) のみ閲覧可。閲覧範囲は RLS (T-D-19) で workspace scope。
実 DB 無なら skip。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from collections.abc import AsyncGenerator, Iterator
from typing import Annotated

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
JWT_SECRET = "test-jwt-secret"
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)

import sqlalchemy  # noqa: E402
from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.dependencies import CurrentUser, get_current_user, get_rls_session  # noqa: E402


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _mint_jwt(user_id: str, *, admin: bool = False) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload_obj: dict[str, object] = {
        "sub": user_id,
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 3600,
    }
    if admin:
        payload_obj["app_metadata"] = {"role": "admin"}
    payload = _b64url(json.dumps(payload_obj).encode())
    sig = _b64url(
        hmac.new(
            JWT_SECRET.encode(), f"{header}.{payload}".encode("ascii"), hashlib.sha256
        ).digest()
    )
    return f"{header}.{payload}.{sig}"


def _db_available() -> bool:
    try:
        eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
        try:
            with eng.connect() as c:
                c.execute(text("select 1"))
        finally:
            eng.dispose()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="local Postgres not available")


@pytest.fixture()
def app() -> Iterator[FastAPI]:
    test_engine = create_async_engine(PG_ASYNC, poolclass=NullPool)

    async def _override_session(
        user: Annotated[CurrentUser, Depends(get_current_user)],
    ) -> AsyncGenerator[AsyncSession, None]:
        claims = json.dumps({"sub": user.id, "role": user.role})
        async with AsyncSession(test_engine) as session:
            await session.execute(
                text("select set_config('request.jwt.claims', :c, true)"), {"c": claims}
            )
            await session.execute(text("set local role authenticated"))
            try:
                yield session
            except Exception:
                await session.rollback()
                raise
            else:
                await session.commit()

    from src.routes import api_router

    application = FastAPI()
    application.include_router(api_router)
    application.dependency_overrides[get_rls_session] = _override_session
    yield application
    asyncio.run(test_engine.dispose())


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    """admin user + workspace (owner) + 監査ログ 1 件を seed。"""
    u_admin = str(uuid.uuid4())
    ws = str(uuid.uuid4())
    with sync_engine.begin() as c:
        c.execute(
            text("insert into auth.users (id,email) values (:i,:e)"),
            {"i": u_admin, "e": f"ta43-{u_admin[:8]}@t.invalid"},
        )
        c.execute(
            text("insert into public.users (id,email) values (:i,:e)"),
            {"i": u_admin, "e": f"ta43-{u_admin[:8]}@t.invalid"},
        )
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
            {"i": ws, "o": u_admin, "n": f"ws-{ws[:6]}"},
        )
        c.execute(
            text(
                "insert into public.audit_logs "
                "(workspace_id, actor_type, actor_id, action, target_type) "
                "values (cast(:w as uuid), 'user', :a, 'workspace.create', 'workspace')"
            ),
            {"w": ws, "a": u_admin},
        )
    yield {"u_admin": u_admin, "ws": ws}
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.audit_logs where workspace_id = cast(:w as uuid)"), {"w": ws}
        )
        c.execute(text("delete from public.workspaces where id = :w"), {"w": ws})
        c.execute(text("delete from public.users where id = :u"), {"u": u_admin})
        c.execute(text("delete from auth.users where id = :u"), {"u": u_admin})


@pytest.mark.integration
class TestAdminAuditLogs:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/admin/audit-logs").status_code == 401

    def test_non_admin_forbidden_403(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(seeded['u_admin'])}"}  # admin claim 無し
        with TestClient(app) as client:
            assert client.get("/admin/audit-logs", headers=h).status_code == 403

    def test_admin_views_audit_logs(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(seeded['u_admin'], admin=True)}"}
        with TestClient(app) as client:
            r = client.get(f"/admin/audit-logs?workspace_id={seeded['ws']}", headers=h)
            assert r.status_code == 200, r.text
            logs = r.json()["data"]
            assert any(
                e["action"] == "workspace.create" and e["workspace_id"] == seeded["ws"]
                for e in logs
            )

    def test_admin_filter_by_action(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(seeded['u_admin'], admin=True)}"}
        with TestClient(app) as client:
            r = client.get("/admin/audit-logs?action=nonexistent.action", headers=h)
            assert r.status_code == 200
            assert r.json()["data"] == []


@pytest.fixture()
def seeded_admin_skills(
    sync_engine: sqlalchemy.Engine,
) -> Iterator[dict[str, str]]:
    """T-A-42: テスト専用 skill + template を seed (superuser でのみ可)。"""
    sk_id = str(uuid.uuid4())
    tpl_id = str(uuid.uuid4())
    with sync_engine.begin() as c:
        c.execute(
            text(
                "insert into public.skills "
                "(id, name, version, description, content_md, allowed_employee_roles, "
                " allowed_employee_ids, is_active) "
                "values (cast(:i as uuid), :n, '0.0.1', 'test desc', '# body', "
                " ARRAY['lead']::text[], ARRAY[]::uuid[], true)"
            ),
            {"i": sk_id, "n": f"sk-test-{sk_id[:8]}"},
        )
        c.execute(
            text(
                "insert into public.ai_employee_templates "
                "(id, default_name, default_display_name, department, role, "
                " system_prompt, specialty, version, is_active) "
                "values (cast(:i as uuid), :n, 'admin テンプレ', 'product', 'member', "
                " 'sp', 'spec', 8888, false)"
            ),
            {"i": tpl_id, "n": f"tpl-admin-{tpl_id[:8]}"},
        )
    yield {"skill_id": sk_id, "template_id": tpl_id}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.skills where id = cast(:i as uuid)"), {"i": sk_id})
        c.execute(
            text("delete from public.ai_employee_templates where id = cast(:i as uuid)"),
            {"i": tpl_id},
        )


@pytest.fixture()
def seeded_dashboard(
    sync_engine: sqlalchemy.Engine,
) -> Iterator[dict[str, str]]:
    """T-A-41: u_admin が ws を 1 件保有・project 2 件・ai_employee 1 件、
    他人 (u_other) が別 ws を保有 (越境集計が含まれないことを検証する)。"""
    u_admin = str(uuid.uuid4())
    u_other = str(uuid.uuid4())
    ws_admin = str(uuid.uuid4())
    ws_other = str(uuid.uuid4())
    proj1, proj2, emp1 = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    proj_other = str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_admin, u_other):
            em = f"ta41-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        for ws, owner in ((ws_admin, u_admin), (ws_other, u_other)):
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": owner, "n": f"ws-{ws[:6]}"},
            )
        for pid, name in ((proj1, "p1"), (proj2, "p2")):
            c.execute(
                text(
                    "insert into public.projects (id,workspace_id,name,project_type) "
                    "values (:i,:w,:n,'internal_product')"
                ),
                {"i": pid, "w": ws_admin, "n": name},
            )
        c.execute(
            text(
                "insert into public.ai_employees "
                "(id,workspace_id,name,display_name,role,department) "
                "values (cast(:i as uuid),cast(:w as uuid),'tony','トニー','lead','sales')"
            ),
            {"i": emp1, "w": ws_admin},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type) "
                "values (:i,:w,'other','internal_product')"
            ),
            {"i": proj_other, "w": ws_other},
        )
    yield {
        "u_admin": u_admin,
        "u_other": u_other,
        "ws_admin": ws_admin,
        "ws_other": ws_other,
    }
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.workspaces where id in (:a,:b)"),
            {"a": ws_admin, "b": ws_other},
        )
        c.execute(
            text("delete from public.users where id in (:a,:b)"),
            {"a": u_admin, "b": u_other},
        )
        c.execute(
            text("delete from auth.users where id in (:a,:b)"),
            {"a": u_admin, "b": u_other},
        )


@pytest.mark.integration
class TestAdminSkillsAndTemplates:
    """T-A-42: 運営 admin スキル + AI 社員テンプレ管理 (read-only)。"""

    def test_skills_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/admin/skills").status_code == 401
            assert client.get("/admin/ai-employee-templates").status_code == 401

    def test_skills_non_admin_forbidden_403(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(seeded['u_admin'])}"}  # 通常 user
        with TestClient(app) as client:
            assert client.get("/admin/skills", headers=h).status_code == 403
            assert client.get("/admin/ai-employee-templates", headers=h).status_code == 403

    def test_admin_lists_skills(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        seeded_admin_skills: dict[str, str],
    ) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(seeded['u_admin'], admin=True)}"}
        with TestClient(app) as client:
            r = client.get("/admin/skills", headers=h)
            assert r.status_code == 200
            ids = {x["id"] for x in r.json()["data"]}
            assert seeded_admin_skills["skill_id"] in ids
            g = client.get(f"/admin/skills/{seeded_admin_skills['skill_id']}", headers=h)
            assert g.status_code == 200
            assert g.json()["data"]["is_active"] is True

    def test_admin_lists_templates_includes_inactive(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        seeded_admin_skills: dict[str, str],
    ) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(seeded['u_admin'], admin=True)}"}
        with TestClient(app) as client:
            # 既定で inactive 含む (admin 横断)
            r = client.get("/admin/ai-employee-templates", headers=h)
            assert r.status_code == 200
            ids = {x["id"] for x in r.json()["data"]}
            assert seeded_admin_skills["template_id"] in ids
            # include_inactive=false で除外
            r2 = client.get("/admin/ai-employee-templates?include_inactive=false", headers=h)
            ids2 = {x["id"] for x in r2.json()["data"]}
            assert seeded_admin_skills["template_id"] not in ids2

    def test_admin_template_detail_and_not_found(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        seeded_admin_skills: dict[str, str],
    ) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(seeded['u_admin'], admin=True)}"}
        with TestClient(app) as client:
            g = client.get(
                f"/admin/ai-employee-templates/{seeded_admin_skills['template_id']}",
                headers=h,
            )
            assert g.status_code == 200
            assert g.json()["data"]["version"] == 8888
            # 不在 → 404
            assert (
                client.get(f"/admin/ai-employee-templates/{uuid.uuid4()}", headers=h).status_code
                == 404
            )
            assert client.get(f"/admin/skills/{uuid.uuid4()}", headers=h).status_code == 404


@pytest.mark.integration
class TestAdminDashboard:
    """T-A-41 dashboard / users: admin 所属 workspaces scope の集計とメンバー一覧。"""

    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/admin/dashboard").status_code == 401
            assert client.get("/admin/users").status_code == 401

    def test_non_admin_forbidden_403(self, app: FastAPI, seeded_dashboard: dict[str, str]) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(seeded_dashboard['u_admin'])}"}
        with TestClient(app) as client:
            assert client.get("/admin/dashboard", headers=h).status_code == 403
            assert client.get("/admin/users", headers=h).status_code == 403

    def test_admin_dashboard_scope_counts(
        self, app: FastAPI, seeded_dashboard: dict[str, str]
    ) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(seeded_dashboard['u_admin'], admin=True)}"}
        with TestClient(app) as client:
            r = client.get("/admin/dashboard", headers=h)
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["workspace_count"] == 1
            assert d["project_count"] == 2
            assert d["ai_employee_count"] == 1
            assert isinstance(d["audit_log_count_24h"], int)

    def test_admin_users_lists_own_ws_members_and_excludes_cross(
        self, app: FastAPI, seeded_dashboard: dict[str, str]
    ) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(seeded_dashboard['u_admin'], admin=True)}"}
        with TestClient(app) as client:
            r = client.get("/admin/users", headers=h)
            assert r.status_code == 200
            users = r.json()["data"]
            assert any(
                u["user_id"] == seeded_dashboard["u_admin"]
                and u["workspace_id"] == seeded_dashboard["ws_admin"]
                and u["role"] == "owner"
                for u in users
            )
            assert all(u["user_id"] != seeded_dashboard["u_other"] for u in users)

    def test_admin_users_filter_by_workspace(
        self, app: FastAPI, seeded_dashboard: dict[str, str]
    ) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(seeded_dashboard['u_admin'], admin=True)}"}
        with TestClient(app) as client:
            r = client.get(
                f"/admin/users?workspace_id={seeded_dashboard['ws_admin']}",
                headers=h,
            )
            assert r.status_code == 200
            users = r.json()["data"]
            assert len(users) >= 1
            assert all(u["workspace_id"] == seeded_dashboard["ws_admin"] for u in users)
