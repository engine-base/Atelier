"""Integration tests for /sales-docs (T-A-39) — 実 Postgres + RLS + JWT。

E-006 workflow_outputs を sales stage (proposal / estimate) でフィルタした
専用 API。401 / 404 / 403 / cross-workspace / audit_logs を網羅。
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
    doc_proposal, doc_estimate, doc_other = (
        str(uuid.uuid4()),
        str(uuid.uuid4()),
        str(uuid.uuid4()),
    )
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta39-{uid[:8]}@t.invalid"
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
                "insert into public.projects (id,workspace_id,name,project_type) "
                "values (:i,:w,:n,'internal_product')"
            ),
            {"i": proj_a, "w": ws_a, "n": "proj-a"},
        )
        # proposal / estimate / design(非 sales) を seed
        for did, stage in (
            (doc_proposal, "proposal"),
            (doc_estimate, "estimate"),
            (doc_other, "design"),
        ):
            c.execute(
                text(
                    "insert into public.workflow_outputs (id,project_id,stage,summary,version) "
                    "values (cast(:i as uuid),cast(:p as uuid),"
                    "cast(:s as workflow_stage_enum),:sm,1)"
                ),
                {"i": did, "p": proj_a, "s": stage, "sm": f"v1 {stage}"},
            )
    yield {
        "u_a": u_a,
        "u_b": u_b,
        "ws_a": ws_a,
        "proj_a": proj_a,
        "doc_proposal": doc_proposal,
        "doc_estimate": doc_estimate,
        "doc_other": doc_other,
    }
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestSalesDocs:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/sales-docs").status_code == 401
            assert client.post("/sales-docs", json={}).status_code == 401

    def test_list_only_sales_stages(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(f"/sales-docs?project_id={seeded['proj_a']}", headers=h)
            assert r.status_code == 200
            ids = {x["id"] for x in r.json()["data"]}
            assert seeded["doc_proposal"] in ids
            assert seeded["doc_estimate"] in ids
            # design stage (非 sales) は除外される
            assert seeded["doc_other"] not in ids

    def test_filter_by_doc_type(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(
                f"/sales-docs?project_id={seeded['proj_a']}&doc_type=proposal", headers=h
            )
            assert r.status_code == 200
            ids = {x["id"] for x in r.json()["data"]}
            assert seeded["doc_proposal"] in ids
            assert seeded["doc_estimate"] not in ids

    def test_get_existing_returns_doc_type(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(f"/sales-docs/{seeded['doc_proposal']}", headers=h)
            assert r.status_code == 200
            assert r.json()["data"]["doc_type"] == "proposal"

    def test_get_design_doc_returns_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        # design ドキュメントは /sales-docs では不可視 (404)
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert client.get(f"/sales-docs/{seeded['doc_other']}", headers=h).status_code == 404

    def test_cross_workspace_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        hb = _h(seeded["u_b"])
        with TestClient(app) as client:
            assert (
                client.get(f"/sales-docs/{seeded['doc_proposal']}", headers=hb).status_code == 404
            )
            r = client.get(f"/sales-docs?project_id={seeded['proj_a']}", headers=hb)
            assert seeded["doc_proposal"] not in {x["id"] for x in r.json()["data"]}

    def test_create_estimate_auto_version_and_audit(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/sales-docs",
                headers=h,
                json={
                    "project_id": seeded["proj_a"],
                    "doc_type": "estimate",
                    "summary": "v2 estimate",
                    "html_path": "outputs/estimate-v2.html",
                },
            )
            assert r.status_code == 201, r.text
            doc = r.json()["data"]
            assert doc["doc_type"] == "estimate"
            assert doc["version"] == 2  # 既存 estimate v1 の次は v2
            assert doc["html_path"] == "outputs/estimate-v2.html"
            new_id = doc["id"]
        # audit_logs に 1 行
        with sync_engine.begin() as c:
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'sales_doc.create' and target_id = cast(:t as uuid)"
                ),
                {"t": new_id},
            ).scalar_one()
            assert cnt == 1

    def test_update_changes_summary_and_audits(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.patch(
                f"/sales-docs/{seeded['doc_proposal']}",
                headers=h,
                json={"summary": "revised"},
            )
            assert r.status_code == 200
            assert r.json()["data"]["summary"] == "revised"
        with sync_engine.begin() as c:
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'sales_doc.update' and target_id = cast(:t as uuid)"
                ),
                {"t": seeded["doc_proposal"]},
            ).scalar_one()
            assert cnt == 1

    def test_delete_soft_and_disappears(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.delete(f"/sales-docs/{seeded['doc_estimate']}", headers=h)
            assert r.status_code == 204
            # 論理削除 → 一覧/取得から消える
            assert client.get(f"/sales-docs/{seeded['doc_estimate']}", headers=h).status_code == 404
        with sync_engine.begin() as c:
            # 行自体は残り deleted_at が NOT NULL
            row = c.execute(
                text("select deleted_at from public.workflow_outputs where id = cast(:i as uuid)"),
                {"i": seeded["doc_estimate"]},
            ).first()
            assert row is not None and row.deleted_at is not None
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'sales_doc.delete' and target_id = cast(:t as uuid)"
                ),
                {"t": seeded["doc_estimate"]},
            ).scalar_one()
            assert cnt == 1

    def test_update_nonexistent_returns_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert (
                client.patch(
                    f"/sales-docs/{uuid.uuid4()}",
                    headers=h,
                    json={"summary": "x"},
                ).status_code
                == 404
            )

    def test_invalid_doc_type_rejected_422(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            # design は sales 範疇外 → schema バリデーションで 422
            r = client.post(
                "/sales-docs",
                headers=h,
                json={"project_id": seeded["proj_a"], "doc_type": "design"},
            )
            assert r.status_code == 422


@pytest.mark.integration
class TestSalesDocsGap018:
    """GAP-018: doc_type 拡張 + AI 生成 (トレース) + PDF + メール送信/履歴。"""

    def test_new_doc_types_crud(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            for doc_type in ("contract", "nda", "invoice"):
                r = client.post(
                    "/sales-docs",
                    headers=h,
                    json={
                        "project_id": seeded["proj_a"],
                        "doc_type": doc_type,
                        "summary": f"# {doc_type} ドラフト",
                    },
                )
                assert r.status_code == 201, r.text
                doc = r.json()["data"]
                assert doc["doc_type"] == doc_type
                assert doc["version"] == 1
                lst = client.get(
                    f"/sales-docs?project_id={seeded['proj_a']}&doc_type={doc_type}",
                    headers=h,
                ).json()["data"]
                assert any(x["id"] == doc["id"] for x in lst)
                client.delete(f"/sales-docs/{doc['id']}", headers=h)

    def test_generate_with_knowledge_trace(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """fake LLM で生成 → meta トレース + knowledge_references 実記録。"""
        monkeypatch.setenv("ATELIER_ALLOW_FAKE_LLM", "1")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("VOYAGE_API_KEY", raising=False)
        kn = str(uuid.uuid4())
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "insert into public.knowledge_nodes "
                    "(id, account_id, account_type, scope, category, title, content_md) "
                    "values (cast(:i as uuid), cast(:a as uuid), 'workspace', 'common', "
                    "'sales', '受託案件の提案書テンプレ v3', '# テンプレ 成約率パターン')"
                ),
                {"i": kn, "a": seeded["ws_a"]},
            )
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/sales-docs/generate",
                headers=h,
                json={
                    "project_id": seeded["proj_a"],
                    "doc_type": "proposal",
                    "customer": "ENGINE BASE 株式会社",
                    "opportunity": "提案書テンプレ活用案件",
                    "notes": "過去の成約パターンを踏まえた提案書を作りたい",
                },
            )
            assert r.status_code == 201, r.text
            doc = r.json()["data"]
            assert doc["meta"]["generated_by"] == "tony"
            assert doc["meta"]["model"] == "fake-llm"
            refs = doc["meta"]["knowledge_refs"]
            assert any(x["id"] == kn for x in refs)
            assert "受託案件の提案書テンプレ v3" in (doc["summary"] or "")
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.knowledge_references "
                        "where referrer_type='sales_doc' and referrer_id=cast(:r as uuid) "
                        "and knowledge_id=cast(:k as uuid)"
                    ),
                    {"r": doc["id"], "k": kn},
                ).scalar_one()
                assert n == 1
                a = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='sales_doc.generate' and target_id=:t"
                    ),
                    {"t": doc["id"]},
                ).scalar_one()
                assert a == 1
            # R-T08: 他 WS からは project 不可視 → 404
            assert (
                client.post(
                    "/sales-docs/generate",
                    headers=_h(seeded["u_b"]),
                    json={
                        "project_id": seeded["proj_a"],
                        "doc_type": "proposal",
                        "customer": "x",
                        "opportunity": "y",
                        "notes": "z",
                    },
                ).status_code
                == 404
            )
            client.delete(f"/sales-docs/{doc['id']}", headers=h)
        with sync_engine.begin() as c:
            c.execute(
                text("delete from public.knowledge_nodes where id = cast(:i as uuid)"), {"i": kn}
            )

    def test_generate_503_when_llm_unconfigured(
        self, app: FastAPI, seeded: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("ATELIER_ALLOW_FAKE_LLM", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        with TestClient(app) as client:
            r = client.post(
                "/sales-docs/generate",
                headers=_h(seeded["u_a"]),
                json={
                    "project_id": seeded["proj_a"],
                    "doc_type": "estimate",
                    "customer": "c",
                    "opportunity": "o",
                    "notes": "n",
                },
            )
            assert r.status_code == 503

    def test_pdf_output(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            doc = client.post(
                "/sales-docs",
                headers=h,
                json={
                    "project_id": seeded["proj_a"],
                    "doc_type": "estimate",
                    "summary": "# 見積書テスト\n\n日本語本文。\n- 項目1\n- 項目2",
                },
            ).json()["data"]
            r = client.get(f"/sales-docs/{doc['id']}/pdf", headers=h)
            assert r.status_code == 200
            assert r.headers["content-type"] == "application/pdf"
            assert r.content.startswith(b"%PDF-")
            # 本文が空のドキュメントは 409 (偽の PDF を出さない)
            empty = client.post(
                "/sales-docs",
                headers=h,
                json={"project_id": seeded["proj_a"], "doc_type": "estimate"},
            ).json()["data"]
            assert client.get(f"/sales-docs/{empty['id']}/pdf", headers=h).status_code == 409
            # R-T08
            assert (
                client.get(f"/sales-docs/{doc['id']}/pdf", headers=_h(seeded["u_b"])).status_code
                == 404
            )
            client.delete(f"/sales-docs/{doc['id']}", headers=h)
            client.delete(f"/sales-docs/{empty['id']}", headers=h)

    def test_send_records_history_with_dry_run(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """メール未設定環境 → dry_run=true を応答/履歴の両方で明示。"""
        monkeypatch.delenv("ATELIER_EMAIL_API_KEY", raising=False)
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            doc = client.post(
                "/sales-docs",
                headers=h,
                json={
                    "project_id": seeded["proj_a"],
                    "doc_type": "proposal",
                    "summary": "# 提案書\n\n本文",
                },
            ).json()["data"]
            r = client.post(
                f"/sales-docs/{doc['id']}/send",
                headers=h,
                json={"to_email": "client@example.com", "message": "ご確認ください"},
            )
            assert r.status_code == 201, r.text
            sent = r.json()["data"]
            assert sent["to_email"] == "client@example.com"
            assert sent["dry_run"] is True
            assert "提案書ドラフト" in sent["subject"]

            sends = client.get(f"/sales-docs/{doc['id']}/sends", headers=h).json()["data"]
            assert len(sends) == 1 and sends[0]["id"] == sent["id"]
            # 不正メールは 422 / R-T08 404
            assert (
                client.post(
                    f"/sales-docs/{doc['id']}/send", headers=h, json={"to_email": "bad"}
                ).status_code
                == 422
            )
            assert (
                client.get(f"/sales-docs/{doc['id']}/sends", headers=_h(seeded["u_b"])).status_code
                == 404
            )
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='sales_doc.send' and target_id=:t"
                    ),
                    {"t": doc["id"]},
                ).scalar_one()
            assert n == 1
            client.delete(f"/sales-docs/{doc['id']}", headers=h)
