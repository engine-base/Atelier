"""Integration tests for /workflow/phases (T-A-20) — 実 Postgres + RLS + JWT。実 DB 無なら skip。"""

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


def _mint_jwt(user_id: str) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url(
        json.dumps(
            {
                "sub": user_id,
                "role": "authenticated",
                "aud": "authenticated",
                "exp": int(time.time()) + 3600,
            }
        ).encode()
    )
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
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    proj_a = str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta20-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        for ws, owner in ((ws_a, u_a), (ws_b, u_b)):
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": owner, "n": f"ws-{ws[:6]}"},
            )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type) values (:i,:w,:n,'internal_product')"
            ),
            {"i": proj_a, "w": ws_a, "n": "proj-a"},
        )
    yield {"u_a": u_a, "u_b": u_b, "ws_a": ws_a, "proj_a": proj_a}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestWorkflowPhases:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/workflow/phases").status_code == 401

    def test_crud_and_transition(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/workflow/phases",
                json={"project_id": seeded["proj_a"], "order": 0, "name": "hearing"},
                headers=h,
            )
            assert r.status_code == 201, r.text
            ph = r.json()["data"]
            assert ph["status"] == "pending"
            assert ph["started_at"] is None
            pid = ph["id"]

            assert any(
                x["id"] == pid
                for x in client.get(
                    f"/workflow/phases?project_id={seeded['proj_a']}", headers=h
                ).json()["data"]
            )
            assert client.get(f"/workflow/phases/{pid}", headers=h).status_code == 200

            # 遷移 → in_progress で started_at 自動セット
            pr = client.patch(f"/workflow/phases/{pid}", json={"status": "in_progress"}, headers=h)
            assert pr.status_code == 200
            assert pr.json()["data"]["status"] == "in_progress"
            assert pr.json()["data"]["started_at"] is not None
            # → completed で completed_at セット
            cr = client.patch(f"/workflow/phases/{pid}", json={"status": "completed"}, headers=h)
            assert cr.json()["data"]["completed_at"] is not None

            assert client.delete(f"/workflow/phases/{pid}", headers=h).status_code == 204
            assert client.get(f"/workflow/phases/{pid}", headers=h).status_code == 404

    def test_seed_default_phases_and_idempotent(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/workflow/phases/seed", json={"project_id": seeded["proj_a"]}, headers=h
            )
            assert r.status_code == 201, r.text
            data = r.json()["data"]
            # 9 工程が order 1..9 で作られる
            assert len(data) == 9
            assert [p["order"] for p in data] == list(range(1, 10))
            assert [p["name"] for p in data] == [
                "ヒアリング",
                "要件定義",
                "アーキ設計",
                "デザイン",
                "機能分解",
                "タスク分解",
                "実装",
                "検証",
                "納品",
            ]
            # 先頭のみ in_progress + started_at、残りは pending
            assert data[0]["status"] == "in_progress"
            assert data[0]["started_at"] is not None
            assert all(p["status"] == "pending" for p in data[1:])
            assert all(p["started_at"] is None for p in data[1:])

            # 冪等: 2 回目でも重複せず 9 件のまま
            r2 = client.post(
                "/workflow/phases/seed", json={"project_id": seeded["proj_a"]}, headers=h
            )
            assert r2.status_code == 201, r2.text
            data2 = r2.json()["data"]
            assert len(data2) == 9
            assert {p["id"] for p in data2} == {p["id"] for p in data}

            # cleanup
            for p in data:
                client.delete(f"/workflow/phases/{p['id']}", headers=h)

    def test_cross_workspace_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            pid = client.post(
                "/workflow/phases",
                json={"project_id": seeded["proj_a"], "order": 1, "name": "design"},
                headers=ha,
            ).json()["data"]["id"]
            assert client.get(f"/workflow/phases/{pid}", headers=hb).status_code == 404
            client.delete(f"/workflow/phases/{pid}", headers=ha)


@pytest.mark.integration
class TestPhaseAssignees:
    """GAP-004: phases.assigned_employee_ids の割当・検証・返却。"""

    def test_assign_and_replace_and_clear(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with sync_engine.connect() as c:
            emps = [
                str(x)
                for (x,) in c.execute(
                    text(
                        "select id from public.ai_employees "
                        "where workspace_id = cast(:w as uuid) order by name limit 2"
                    ),
                    {"w": seeded["ws_a"]},
                ).all()
            ]
        assert len(emps) == 2  # WS 自動シード (T-A-54) 前提
        with TestClient(app) as client:
            ph = client.post(
                "/workflow/phases",
                headers=h,
                json={"project_id": seeded["proj_a"], "order": 90, "name": "assign-test"},
            ).json()["data"]
            assert ph["assigned_employee_ids"] == []
            # 割当
            up = client.patch(
                f"/workflow/phases/{ph['id']}",
                headers=h,
                json={"assigned_employee_ids": emps},
            )
            assert up.status_code == 200, up.text
            assert sorted(up.json()["data"]["assigned_employee_ids"]) == sorted(emps)
            # 置換 (1 名に)
            up2 = client.patch(
                f"/workflow/phases/{ph['id']}",
                headers=h,
                json={"assigned_employee_ids": [emps[0]]},
            )
            assert up2.json()["data"]["assigned_employee_ids"] == [emps[0]]
            # クリア
            up3 = client.patch(
                f"/workflow/phases/{ph['id']}",
                headers=h,
                json={"assigned_employee_ids": []},
            )
            assert up3.json()["data"]["assigned_employee_ids"] == []
            client.delete(f"/workflow/phases/{ph['id']}", headers=h)

    def test_cross_workspace_employee_rejected_422(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """他 WS の社員 ID は 422 (R-T08 系の越境割当を拒否)。"""
        h = _h(seeded["u_a"])
        with sync_engine.connect() as c:
            other = c.execute(
                text(
                    "select e.id from public.ai_employees e "
                    "where e.workspace_id <> cast(:w as uuid) limit 1"
                ),
                {"w": seeded["ws_a"]},
            ).scalar_one()
        with TestClient(app) as client:
            ph = client.post(
                "/workflow/phases",
                headers=h,
                json={"project_id": seeded["proj_a"], "order": 91, "name": "assign-xws"},
            ).json()["data"]
            r = client.patch(
                f"/workflow/phases/{ph['id']}",
                headers=h,
                json={"assigned_employee_ids": [str(other)]},
            )
            assert r.status_code == 422
            client.delete(f"/workflow/phases/{ph['id']}", headers=h)


def _seed_task(
    sync_engine: sqlalchemy.Engine,
    project_id: str,
    *,
    title: str,
    lifecycle: str = "triage",
    dependencies: list[str] | None = None,
    phase_id: str | None = None,
) -> str:
    tid = str(uuid.uuid4())
    with sync_engine.begin() as c:
        c.execute(
            text(
                "insert into public.tasks "
                "(id, project_id, phase_id, category, title, type, estimated_hours, "
                " lifecycle_stage, dependencies) "
                "values (cast(:i as uuid), cast(:p as uuid), cast(:ph as uuid), 'misc', "
                ":t, 'feature', 2, cast(:l as task_lifecycle_enum), cast(:d as uuid[]))"
            ),
            {
                "i": tid,
                "p": project_id,
                "ph": phase_id,
                "t": title,
                "l": lifecycle,
                "d": dependencies or [],
            },
        )
    return tid


@pytest.mark.integration
class TestPhaseProposalsAndImpact:
    """GAP-022: AI 提案フェーズ + F-IMP01 影響範囲解析 + phase 別集計。"""

    def test_proposal_lifecycle(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("ATELIER_ALLOW_FAKE_LLM", "1")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            base = client.post(
                "/workflow/phases",
                headers=h,
                json={"project_id": seeded["proj_a"], "order": 1, "name": "基盤"},
            ).json()["data"]

            r = client.post(
                "/workflow/phase-proposals",
                headers=h,
                json={"project_id": seeded["proj_a"]},
            )
            assert r.status_code == 201, r.text
            prop = r.json()["data"]
            assert prop["status"] == "pending"
            assert prop["proposed_by"] == "jarvis"
            assert prop["reason"]
            assert prop["proposed_order"] == 2
            # 1 プロジェクト 1 pending
            assert (
                client.post(
                    "/workflow/phase-proposals",
                    headers=h,
                    json={"project_id": seeded["proj_a"]},
                ).status_code
                == 409
            )
            # R-T08: 他 WS ユーザーからは project 不可視 → 404
            assert (
                client.post(
                    "/workflow/phase-proposals",
                    headers=_h(seeded["u_b"]),
                    json={"project_id": seeded["proj_a"]},
                ).status_code
                == 404
            )

            a = client.post(f"/workflow/phase-proposals/{prop['id']}/approve", headers=h)
            assert a.status_code == 200, a.text
            body = a.json()["data"]
            assert body["proposal"]["status"] == "approved"
            assert body["phase"]["name"] == prop["name"]
            assert body["phase"]["order"] == 2
            assert body["proposal"]["approved_phase_id"] == body["phase"]["id"]
            # 二重承認 409 / 不正 UUID 404
            assert (
                client.post(
                    f"/workflow/phase-proposals/{prop['id']}/approve", headers=h
                ).status_code
                == 409
            )
            assert (
                client.post("/workflow/phase-proposals/junk/approve", headers=h).status_code == 404
            )

            # 却下: 新しい提案 → reject → フェーズは増えない
            p2 = client.post(
                "/workflow/phase-proposals",
                headers=h,
                json={"project_id": seeded["proj_a"]},
            ).json()["data"]
            before = len(
                client.get(f"/workflow/phases?project_id={seeded['proj_a']}", headers=h).json()[
                    "data"
                ]
            )
            rj = client.post(f"/workflow/phase-proposals/{p2['id']}/reject", headers=h)
            assert rj.status_code == 200
            assert rj.json()["data"]["status"] == "rejected"
            after = len(
                client.get(f"/workflow/phases?project_id={seeded['proj_a']}", headers=h).json()[
                    "data"
                ]
            )
            assert before == after

            lst = client.get(f"/workflow/phase-proposals?project_id={seeded['proj_a']}", headers=h)
            assert sorted(x["status"] for x in lst.json()["data"]) == ["approved", "rejected"]
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs where action like "
                        "'phase.proposal.%'"
                    )
                ).scalar_one()
            assert n >= 4
            client.delete(f"/workflow/phases/{base['id']}", headers=h)
            client.delete(f"/workflow/phases/{body['phase']['id']}", headers=h)

    def test_proposal_503_when_llm_unconfigured(
        self, app: FastAPI, seeded: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("ATELIER_ALLOW_FAKE_LLM", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        with TestClient(app) as client:
            r = client.post(
                "/workflow/phase-proposals",
                headers=_h(seeded["u_a"]),
                json={"project_id": seeded["proj_a"]},
            )
            assert r.status_code == 503

    def test_impact_analyze_apply_and_stats(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """M ← B(done) ← C(triage) の推移的走査 → apply で移動 + リファクタ自動起票。"""
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            p1 = client.post(
                "/workflow/phases",
                headers=h,
                json={"project_id": seeded["proj_a"], "order": 11, "name": "実装"},
            ).json()["data"]
            p2 = client.post(
                "/workflow/phases",
                headers=h,
                json={"project_id": seeded["proj_a"], "order": 12, "name": "検証"},
            ).json()["data"]
            m = _seed_task(sync_engine, seeded["proj_a"], title="移動対象M", phase_id=p1["id"])
            b = _seed_task(
                sync_engine,
                seeded["proj_a"],
                title="影響B",
                lifecycle="done",
                dependencies=[m],
                phase_id=p1["id"],
            )
            c_task = _seed_task(
                sync_engine,
                seeded["proj_a"],
                title="影響C",
                dependencies=[b],
                phase_id=p1["id"],
            )

            r = client.post(
                "/workflow/impact-analysis",
                headers=h,
                json={"task_id": m, "target_phase_id": p2["id"]},
            )
            assert r.status_code == 201, r.text
            ana = r.json()["data"]
            assert {x["id"] for x in ana["affected"]} == {b, c_task}
            assert ana["done_count"] == 1
            assert ana["applied"] is False

            # 別プロジェクトのフェーズへは 422
            proj_b = str(uuid.uuid4())
            with sync_engine.begin() as cx:
                cx.execute(
                    text(
                        "insert into public.projects (id,workspace_id,name,project_type) "
                        "values (cast(:i as uuid),cast(:w as uuid),'proj-b','internal_product')"
                    ),
                    {"i": proj_b, "w": seeded["ws_a"]},
                )
            other_phase = client.post(
                "/workflow/phases",
                headers=h,
                json={"project_id": proj_b, "order": 1, "name": "other"},
            ).json()["data"]
            assert (
                client.post(
                    "/workflow/impact-analysis",
                    headers=h,
                    json={"task_id": m, "target_phase_id": other_phase["id"]},
                ).status_code
                == 422
            )

            # apply → 実移動 + 完了済 B のリファクタ自動起票 (origin_type=refactor)
            ap = client.post(f"/workflow/impact-analysis/{ana['id']}/apply", headers=h)
            assert ap.status_code == 200, ap.text
            applied = ap.json()["data"]
            assert applied["moved_to_phase_id"] == p2["id"]
            assert len(applied["refactor_task_ids"]) == 1
            with sync_engine.connect() as cx:
                moved_phase = cx.execute(
                    text("select phase_id from public.tasks where id = cast(:i as uuid)"),
                    {"i": m},
                ).scalar_one()
                assert str(moved_phase) == p2["id"]
                ref = cx.execute(
                    text(
                        "select title, origin_type, lifecycle_stage, category "
                        "from public.tasks where id = cast(:i as uuid)"
                    ),
                    {"i": applied["refactor_task_ids"][0]},
                ).one()
                assert ref.origin_type == "refactor"
                assert ref.lifecycle_stage == "triage"
                assert ref.category == "リファクタ"
                assert "影響B" in ref.title
            # 二重適用 409
            assert (
                client.post(f"/workflow/impact-analysis/{ana['id']}/apply", headers=h).status_code
                == 409
            )

            # 統計: 本日実行回数 >= 1、整合性 OK
            st = client.get(
                f"/workflow/impact-stats?project_id={seeded['proj_a']}", headers=h
            ).json()["data"]
            assert st["today_count"] >= 1
            assert st["consistency_ok"] is True
            # dangling 依存を作ると NG
            _seed_task(
                sync_engine,
                seeded["proj_a"],
                title="宙ぶらりんD",
                dependencies=[str(uuid.uuid4())],
            )
            st2 = client.get(
                f"/workflow/impact-stats?project_id={seeded['proj_a']}", headers=h
            ).json()["data"]
            assert st2["consistency_ok"] is False
            assert st2["dangling_count"] == 1

            # phase 別集計 (p2 = M + リファクタ 2 件 / done 0 / p1 = B done + C)
            stats = {
                s["phase_id"]: s
                for s in client.get(
                    f"/workflow/phase-task-stats?project_id={seeded['proj_a']}",
                    headers=h,
                ).json()["data"]
            }
            assert stats[p1["id"]]["total"] == 2
            assert stats[p1["id"]]["done"] == 1
            assert stats[p2["id"]]["total"] == 2
