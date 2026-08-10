"""Integration tests for /outputs (T-A-21) — 実 Postgres + RLS + JWT。実 DB 無なら skip。"""

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
    proj_a, out_a = str(uuid.uuid4()), str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta21-{uid[:8]}@t.invalid"
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
        # 成果物は工程生成で作られるため、service_role 相当 (superuser) で seed
        c.execute(
            text(
                "insert into public.workflow_outputs (id,project_id,stage,summary) values (cast(:i as uuid),cast(:p as uuid),'design','sum')"
            ),
            {"i": out_a, "p": proj_a},
        )
    yield {"u_a": u_a, "u_b": u_b, "ws_a": ws_a, "proj_a": proj_a, "out_a": out_a}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


_ANCHOR_HTML = (
    "<html><body>"
    '<h2 id="sec-1">1. プロジェクト概要</h2><p>本文</p>'
    '<h2 id="sec-2">2. 成功の定義</h2>'
    "</body></html>"
)


def _install_storage_fakes(
    monkeypatch: pytest.MonkeyPatch, *, source_html: str = _ANCHOR_HTML
) -> list[str]:
    """outputs revise 経路の storage HTTP 境界をフェイク化する (GAP-023 テスト用)。

    署名 (post) / 取得 (get) / アップロード (put) を 1 つのフェイクで担い、
    アップロードされた HTML 本文の記録リストを返す。
    """
    from typing import Any

    from src import storage_signing
    from src.services.outputs import revise as revise_svc

    monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "https://stor.invalid")
    monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "svc-key")
    uploaded: list[str] = []

    class _Res:
        def __init__(self, payload: dict[str, Any] | None = None, body_text: str = "") -> None:
            self.status_code = 200
            self._payload = payload or {}
            self.text = body_text

        def json(self) -> dict[str, Any]:
            return self._payload

    class _StorageClient:
        def __init__(self, *_a: Any, **_k: Any) -> None: ...

        async def __aenter__(self) -> _StorageClient:
            return self

        async def __aexit__(self, *_a: Any) -> bool:
            return False

        async def post(self, url: str, **_k: Any) -> _Res:
            if "/object/upload/sign/" in url:
                return _Res({"url": "/object/upload/sign/outputs/x?token=u"})
            return _Res({"signedURL": "/object/sign/outputs/x?token=d"})

        async def get(self, _url: str, **_k: Any) -> _Res:
            return _Res(body_text=source_html)

        async def put(self, _url: str, *, content: bytes, **_k: Any) -> _Res:
            uploaded.append(content.decode("utf-8"))
            return _Res()

    monkeypatch.setattr(storage_signing.httpx, "AsyncClient", _StorageClient)
    assert revise_svc.httpx.AsyncClient is _StorageClient  # 共有モジュールの前提を明示
    return uploaded


@pytest.mark.integration
class TestOutputs:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/outputs").status_code == 401

    def test_list_and_get(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            lst = client.get(f"/outputs?project_id={seeded['proj_a']}", headers=h)
            assert lst.status_code == 200
            assert any(x["id"] == seeded["out_a"] for x in lst.json()["data"])
            # stage filter
            assert any(
                x["id"] == seeded["out_a"]
                for x in client.get(
                    f"/outputs?project_id={seeded['proj_a']}&stage=design", headers=h
                ).json()["data"]
            )
            g = client.get(f"/outputs/{seeded['out_a']}", headers=h)
            assert g.status_code == 200
            assert g.json()["data"]["stage"] == "design"

    def test_cross_workspace_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        hb = _h(seeded["u_b"])
        with TestClient(app) as client:
            assert client.get(f"/outputs/{seeded['out_a']}", headers=hb).status_code == 404
            assert all(
                x["id"] != seeded["out_a"]
                for x in client.get(f"/outputs?project_id={seeded['proj_a']}", headers=hb).json()[
                    "data"
                ]
            )


def _seed_output(
    sync_engine: sqlalchemy.Engine,
    seeded: dict[str, str],
    *,
    html_path: str | None = "outputs/g01test/doc-v1.html",
    md_path: str | None = None,
    version: int = 1,
) -> str:
    oid = str(uuid.uuid4())
    with sync_engine.begin() as c:
        c.execute(
            text(
                "insert into public.workflow_outputs "
                "(id,project_id,stage,summary,html_path,md_path,version) "
                "values (cast(:i as uuid),cast(:p as uuid),'requirements','要件定義書',"
                ":hp,:mp,:v)"
            ),
            {"i": oid, "p": seeded["proj_a"], "hp": html_path, "mp": md_path, "v": version},
        )
    return oid


@pytest.mark.integration
class TestOutputViewerOps:
    """GAP-023: format 別 content-url / versions / anchors / revise / fix-proposals。"""

    def test_content_url_format_md_and_missing_409(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _install_storage_fakes(monkeypatch)
        oid = _seed_output(sync_engine, seeded, md_path="outputs/g01test/doc-v1.md")
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert client.get(f"/outputs/{oid}/content-url?format=md", headers=h).status_code == 200
            assert client.get(f"/outputs/{oid}/content-url", headers=h).status_code == 200
            # json は未生成 → 409 (存在しない版を偽装しない)
            r = client.get(f"/outputs/{oid}/content-url?format=json", headers=h)
            assert r.status_code == 409

    def test_versions_chain_and_cross_ws_404(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        o1 = _seed_output(sync_engine, seeded, version=1)
        o2 = _seed_output(sync_engine, seeded, version=2)
        with TestClient(app) as client:
            r = client.get(f"/outputs/{o1}/versions", headers=_h(seeded["u_a"]))
            assert r.status_code == 200
            versions = [x["version"] for x in r.json()["data"] if x["id"] in (o1, o2)]
            assert versions == [1, 2]
            assert (
                client.get(f"/outputs/{o1}/versions", headers=_h(seeded["u_b"])).status_code == 404
            )

    def test_anchors_extracted_from_real_html(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _install_storage_fakes(monkeypatch)
        oid = _seed_output(sync_engine, seeded)
        with TestClient(app) as client:
            r = client.get(f"/outputs/{oid}/anchors", headers=_h(seeded["u_a"]))
            assert r.status_code == 200
            anchors = {a["element_id"]: a["label"] for a in r.json()["data"]}
            assert anchors["sec-1"] == "1. プロジェクト概要"
            assert "sec-2" in anchors
            # HTML 未生成は 409
            no_html = _seed_output(sync_engine, seeded, html_path=None, version=9)
            assert (
                client.get(f"/outputs/{no_html}/anchors", headers=_h(seeded["u_a"])).status_code
                == 409
            )

    def test_revise_fake_llm_creates_steve_version(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        uploaded = _install_storage_fakes(monkeypatch)
        monkeypatch.setenv("ATELIER_ALLOW_FAKE_LLM", "1")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        oid = _seed_output(sync_engine, seeded, md_path="outputs/g01test/doc-v1.md")
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/outputs/{oid}/revise",
                json={"instruction": "2.5 項に可視範囲サブセクションを追加"},
                headers=h,
            )
            assert r.status_code == 201, r.text
            v2 = r.json()["data"]
            assert v2["version"] == 2
            assert v2["meta"]["author"] == "steve"
            assert v2["meta"]["revision_instruction"] == "2.5 項に可視範囲サブセクションを追加"
            assert v2["meta"]["model"] == "fake-llm"
            assert v2["html_path"].endswith("-rev.html")
            # 改訂は HTML に対して行われるため json/md は未生成 (旧版を偽装しない)
            assert v2["json_path"] is None and v2["md_path"] is None
            assert len(uploaded) == 1 and 'data-fake-revision="1"' in uploaded[0]
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='output.revise' and target_id=:t"
                    ),
                    {"t": v2["id"]},
                ).scalar_one()
            assert n == 1

    def test_revise_503_and_409_no_html(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        _install_storage_fakes(monkeypatch)
        monkeypatch.delenv("ATELIER_ALLOW_FAKE_LLM", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        oid = _seed_output(sync_engine, seeded)
        no_html = _seed_output(sync_engine, seeded, html_path=None, version=8)
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert (
                client.post(f"/outputs/{oid}/revise", json={"instruction": "x"}, headers=h)
            ).status_code == 503
            assert (
                client.post(f"/outputs/{no_html}/revise", json={"instruction": "x"}, headers=h)
            ).status_code == 409
            # R-T08: 他 WS からは 404
            monkeypatch.setenv("ATELIER_ALLOW_FAKE_LLM", "1")
            assert (
                client.post(
                    f"/outputs/{oid}/revise",
                    json={"instruction": "越境"},
                    headers=_h(seeded["u_b"]),
                )
            ).status_code == 404
            # 不正 UUID は 500 ではなく 404 (実監査が検出した 500 の回帰ガード)
            assert (
                client.post("/outputs/not-a-uuid/revise", json={"instruction": "x"}, headers=h)
            ).status_code == 404
            assert (
                client.post("/comments/optimistic-2/fix-proposal", headers=h)
            ).status_code == 404
            assert (client.post("/output-fix-proposals/junk/approve", headers=h)).status_code == 404

    def test_fix_proposal_lifecycle(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """提案生成 (pending, 重複 409) → 承認 (新バージョン + approved) / 却下 (不変)。"""
        _install_storage_fakes(monkeypatch)
        monkeypatch.setenv("ATELIER_ALLOW_FAKE_LLM", "1")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        oid = _seed_output(sync_engine, seeded)
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            c1 = client.post(
                "/comments",
                json={
                    "target_type": "workflow_output",
                    "target_id": oid,
                    "content": "可視範囲を明示してほしい",
                    "target_element_id": "sec-1",
                },
                headers=h,
            ).json()["data"]
            assert c1["target_element_id"] == "sec-1"

            p = client.post(f"/comments/{c1['id']}/fix-proposal", headers=h)
            assert p.status_code == 201, p.text
            prop = p.json()["data"]
            assert prop["status"] == "pending"
            assert "可視範囲を明示してほしい" in prop["proposal"]
            # 同一コメントへの pending 重複は 409
            assert client.post(f"/comments/{c1['id']}/fix-proposal", headers=h).status_code == 409

            a = client.post(f"/output-fix-proposals/{prop['id']}/approve", headers=h)
            assert a.status_code == 200, a.text
            body = a.json()["data"]
            assert body["proposal"]["status"] == "approved"
            assert body["new_output"]["version"] == 2
            assert body["proposal"]["applied_output_id"] == body["new_output"]["id"]
            # 二重承認は 409
            assert (
                client.post(f"/output-fix-proposals/{prop['id']}/approve", headers=h).status_code
                == 409
            )

            # 却下: 文書は不変 (バージョン数が増えない)
            c2 = client.post(
                "/comments",
                json={"target_type": "workflow_output", "target_id": oid, "content": "別件"},
                headers=h,
            ).json()["data"]
            p2 = client.post(f"/comments/{c2['id']}/fix-proposal", headers=h).json()["data"]
            before = len(client.get(f"/outputs/{oid}/versions", headers=h).json()["data"])
            rj = client.post(f"/output-fix-proposals/{p2['id']}/reject", headers=h)
            assert rj.status_code == 200
            assert rj.json()["data"]["status"] == "rejected"
            after = len(client.get(f"/outputs/{oid}/versions", headers=h).json()["data"])
            assert before == after

            lst = client.get(f"/outputs/{oid}/fix-proposals", headers=h)
            assert lst.status_code == 200
            statuses = sorted(x["status"] for x in lst.json()["data"])
            assert statuses == ["approved", "rejected"]
            # R-T08: 他 WS からは提案一覧も 404
            assert (
                client.get(f"/outputs/{oid}/fix-proposals", headers=_h(seeded["u_b"])).status_code
                == 404
            )
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs where action in "
                        "('output.fix_proposal.propose','output.fix_proposal.approve',"
                        "'output.fix_proposal.reject') and target_id in (:o, :n2)"
                    ),
                    {"o": oid, "n2": body["new_output"]["id"]},
                ).scalar_one()
            assert n >= 3
