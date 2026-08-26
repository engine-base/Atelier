"""Integration tests for /mocks (T-A-33) — 実 Postgres + RLS + JWT。

user + workspace(owner) + project を seed し、mock CRUD + バージョン管理を検証。
get_current_user は本物、get_rls_session は NullPool override。実 DB 無なら skip。
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
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta33-{uid[:8]}@t.invalid"
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
    yield {"u_a": u_a, "u_b": u_b, "ws_a": ws_a, "ws_b": ws_b, "proj_a": proj_a}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


def _install_storage_fakes(monkeypatch: pytest.MonkeyPatch, *, source_html: str) -> list[str]:
    """revise 経路の storage HTTP 境界をフェイク化する (GAP-024 テスト用)。

    - storage_signing.httpx : 署名 API (download/upload sign) を成功応答に
    - services.mocks.revise.httpx : GET=現行 HTML / PUT=アップロード記録
    返り値はアップロードされた HTML 本文の記録リスト。
    """
    from typing import Any

    from src import storage_signing
    from src.services.mocks import revise as revise_svc

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

    # storage_signing と revise は同一 httpx モジュールを共有するため、
    # 署名 (post) / 取得 (get) / アップロード (put) を 1 つのフェイクで担う。
    class _StorageClient:
        def __init__(self, *_a: Any, **_k: Any) -> None: ...

        async def __aenter__(self) -> _StorageClient:
            return self

        async def __aexit__(self, *_a: Any) -> bool:
            return False

        async def post(self, url: str, **_k: Any) -> _Res:
            if "/object/upload/sign/" in url:
                return _Res({"url": "/object/upload/sign/mocks/x?token=u"})
            return _Res({"signedURL": "/object/sign/mocks/x?token=d"})

        async def get(self, _url: str, **_k: Any) -> _Res:
            return _Res(body_text=source_html)

        async def put(self, _url: str, *, content: bytes, **_k: Any) -> _Res:
            uploaded.append(content.decode("utf-8"))
            return _Res()

    monkeypatch.setattr(storage_signing.httpx, "AsyncClient", _StorageClient)
    assert revise_svc.httpx.AsyncClient is _StorageClient  # 共有モジュールの前提を明示
    return uploaded


@pytest.mark.integration
class TestMocksCrud:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/mocks").status_code == 401

    def test_full_crud(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/mocks",
                json={
                    "project_id": seeded["proj_a"],
                    "screen_name": "S-LOGIN",
                    "html_storage_path": "mocks/login-v1.html",
                    "meta_tags": {"k": "v"},
                },
                headers=h,
            )
            assert r.status_code == 201, r.text
            m = r.json()["data"]
            assert m["version"] == 1
            assert m["parent_mock_id"] is None
            assert m["meta_tags"] == {"k": "v"}
            mid = m["id"]

            assert any(
                x["id"] == mid
                for x in client.get(f"/mocks?project_id={seeded['proj_a']}", headers=h).json()[
                    "data"
                ]
            )
            assert client.get(f"/mocks/{mid}", headers=h).status_code == 200

            pr = client.patch(
                f"/mocks/{mid}", json={"html_storage_path": "mocks/login-v1b.html"}, headers=h
            )
            assert pr.status_code == 200
            assert pr.json()["data"]["html_storage_path"] == "mocks/login-v1b.html"

            assert client.delete(f"/mocks/{mid}", headers=h).status_code == 204
            assert client.get(f"/mocks/{mid}", headers=h).status_code == 404

    def test_version_chain(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            v1 = client.post(
                "/mocks",
                json={
                    "project_id": seeded["proj_a"],
                    "screen_name": "S-HOME",
                    "html_storage_path": "mocks/home-v1.html",
                },
                headers=h,
            ).json()["data"]
            assert v1["version"] == 1

            r2 = client.post(
                f"/mocks/{v1['id']}/versions",
                json={"html_storage_path": "mocks/home-v2.html"},
                headers=h,
            )
            assert r2.status_code == 201, r2.text
            v2 = r2.json()["data"]
            assert v2["version"] == 2
            assert v2["parent_mock_id"] == v1["id"]

            # 履歴は v1, v2 を version 昇順で返す
            hist = client.get(f"/mocks/{v1['id']}/versions", headers=h).json()["data"]
            assert [h_["version"] for h_ in hist] == [1, 2]
            client.delete(f"/mocks/{v2['id']}", headers=h)
            client.delete(f"/mocks/{v1['id']}", headers=h)

    def test_cross_workspace_mock_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            mid = client.post(
                "/mocks",
                json={
                    "project_id": seeded["proj_a"],
                    "screen_name": "S-X",
                    "html_storage_path": "x.html",
                },
                headers=ha,
            ).json()["data"]["id"]
            assert client.get(f"/mocks/{mid}", headers=hb).status_code == 404
            client.delete(f"/mocks/{mid}", headers=ha)

    def test_revise_fake_llm_creates_wanda_version(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """編集 = ワンダ (AI) への修正依頼 → 新バージョン (GAP-024)。

        storage は HTTP 境界 (署名 + GET/PUT) をフェイクに差し替え、
        LLM は ATELIER_ALLOW_FAKE_LLM=1 の決定的スタブ経路を通す。
        """
        uploaded = _install_storage_fakes(
            monkeypatch, source_html="<html><body><h1>v1</h1></body></html>"
        )
        monkeypatch.setenv("ATELIER_ALLOW_FAKE_LLM", "1")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            v1 = client.post(
                "/mocks",
                json={
                    "project_id": seeded["proj_a"],
                    "screen_name": "S-REV",
                    "html_storage_path": "mocks/rev-v1.html",
                },
                headers=h,
            ).json()["data"]
            r = client.post(
                f"/mocks/{v1['id']}/revise",
                json={"instruction": "ヘッダーをブランドカラーに変更"},
                headers=h,
            )
            assert r.status_code == 201, r.text
            v2 = r.json()["data"]
            assert v2["version"] == 2
            assert v2["parent_mock_id"] == v1["id"]
            assert v2["meta_tags"]["author"] == "wanda"
            assert v2["meta_tags"]["revision_instruction"] == "ヘッダーをブランドカラーに変更"
            # GAP-138: model はチェーンの provider ラベル (relay/agent_sdk/api/fake)
            assert v2["meta_tags"]["model"] == "fake"
            assert v2["html_storage_path"].endswith("-rev.html")
            # 改訂 HTML が実際にアップロードされ、指示バナーが入っている
            assert len(uploaded) == 1
            assert 'data-fake-revision="1"' in uploaded[0]
            assert "ヘッダーをブランドカラーに変更" in uploaded[0]
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='mock.version_create' and target_id=:t"
                    ),
                    {"t": v2["id"]},
                ).scalar_one()
            assert n == 1
            client.delete(f"/mocks/{v2['id']}", headers=h)
            client.delete(f"/mocks/{v1['id']}", headers=h)

    def test_revise_503_when_llm_unconfigured(
        self, app: FastAPI, seeded: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """ANTHROPIC_API_KEY 無 + fake 不許可は 503 (偽の改訂を出さない)。"""
        _install_storage_fakes(monkeypatch, source_html="<html><body>x</body></html>")
        monkeypatch.delenv("ATELIER_ALLOW_FAKE_LLM", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            mid = client.post(
                "/mocks",
                json={
                    "project_id": seeded["proj_a"],
                    "screen_name": "S-REV503",
                    "html_storage_path": "mocks/rev503.html",
                },
                headers=h,
            ).json()["data"]["id"]
            r = client.post(f"/mocks/{mid}/revise", json={"instruction": "何か直して"}, headers=h)
            assert r.status_code == 503
            client.delete(f"/mocks/{mid}", headers=h)

    def test_revise_cross_workspace_404(
        self, app: FastAPI, seeded: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """R-T08: 他ワークスペースの mock への修正依頼は 404。"""
        _install_storage_fakes(monkeypatch, source_html="<html></html>")
        monkeypatch.setenv("ATELIER_ALLOW_FAKE_LLM", "1")
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            mid = client.post(
                "/mocks",
                json={
                    "project_id": seeded["proj_a"],
                    "screen_name": "S-REVX",
                    "html_storage_path": "mocks/revx.html",
                },
                headers=ha,
            ).json()["data"]["id"]
            r = client.post(f"/mocks/{mid}/revise", json={"instruction": "越境"}, headers=hb)
            assert r.status_code == 404
            client.delete(f"/mocks/{mid}", headers=ha)

    def test_duplicate_and_discard(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """複製は同一 HTML 参照の新バージョン、破棄は soft delete + 唯一版 409。"""
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            v1 = client.post(
                "/mocks",
                json={
                    "project_id": seeded["proj_a"],
                    "screen_name": "S-DUP",
                    "html_storage_path": "mocks/dup-v1.html",
                },
                headers=h,
            ).json()["data"]
            r = client.post(f"/mocks/{v1['id']}/duplicate", headers=h)
            assert r.status_code == 201, r.text
            v2 = r.json()["data"]
            assert v2["version"] == 2
            assert v2["html_storage_path"] == v1["html_storage_path"]
            assert v2["meta_tags"]["duplicated_from_version"] == 1
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='mock.duplicate' and target_id=:t"
                    ),
                    {"t": v2["id"]},
                ).scalar_one()
            assert n == 1

            # v2 破棄 → 404 化、v1 は唯一版になり 409
            assert client.post(f"/mocks/{v2['id']}/discard", headers=h).status_code == 200
            assert client.get(f"/mocks/{v2['id']}", headers=h).status_code == 404
            r409 = client.post(f"/mocks/{v1['id']}/discard", headers=h)
            assert r409.status_code == 409
            client.delete(f"/mocks/{v1['id']}", headers=h)

    def test_create_writes_audit_log(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            mid = client.post(
                "/mocks",
                json={
                    "project_id": seeded["proj_a"],
                    "screen_name": "S-AUD",
                    "html_storage_path": "a.html",
                },
                headers=h,
            ).json()["data"]["id"]
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='mock.create' and target_id=:t"
                    ),
                    {"t": mid},
                ).scalar_one()
            assert n == 1
            client.delete(f"/mocks/{mid}", headers=h)


# ── GAP-155: 同時編集ガード + バージョン間差分 ──────────────────────────────

_V1_HTML = "<html>\n<body>\n<h1>旧見出し</h1>\n<p>共通の本文</p>\n</body>\n</html>"
_V2_HTML = (
    "<html>\n<body>\n<h1>新見出し</h1>\n<p>共通の本文</p>\n<p>追加の段落</p>\n</body>\n</html>"
)


@pytest.mark.integration
class TestGap155VersionGuard:
    """(project, 画面, version) 一意制約 + 409 + サーバ計算 diff の実挙動。"""

    def _seed_mockdb_version(
        self,
        sync_engine: sqlalchemy.Engine,
        *,
        project_id: str,
        screen: str,
        html: str,
        version: int,
        parent: str | None = None,
    ) -> str:
        """mock_contents に実 HTML を置き mockdb:// 参照の mocks 行を作る。"""
        mid = str(uuid.uuid4())
        with sync_engine.begin() as c:
            cid = c.execute(
                text("insert into public.mock_contents (html) values (:h) returning id"),
                {"h": html},
            ).scalar_one()
            c.execute(
                text(
                    "insert into public.mocks "
                    "(id, project_id, screen_name, html_storage_path, version, parent_mock_id) "
                    "values (cast(:i as uuid), cast(:p as uuid), :s, :path, :v, cast(:par as uuid))"
                ),
                {
                    "i": mid,
                    "p": project_id,
                    "s": screen,
                    "path": f"mockdb://{cid}",
                    "v": version,
                    "par": parent,
                },
            )
        return mid

    def test_diff_returns_real_unified_diff(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """差分はサーバが実 HTML 2 版から difflib で計算する (近似・推測なし)。"""
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from src.services.mocks import artifacts as artifacts_svc

        test_engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
        monkeypatch.setattr(
            artifacts_svc,
            "service_session_factory",
            lambda: async_sessionmaker(test_engine, class_=AsyncSession),
        )
        v1 = self._seed_mockdb_version(
            sync_engine, project_id=seeded["proj_a"], screen="S-155", html=_V1_HTML, version=1
        )
        v2 = self._seed_mockdb_version(
            sync_engine,
            project_id=seeded["proj_a"],
            screen="S-155",
            html=_V2_HTML,
            version=2,
            parent=v1,
        )
        other_screen = self._seed_mockdb_version(
            sync_engine, project_id=seeded["proj_a"], screen="S-OTHER", html=_V1_HTML, version=1
        )
        try:
            with TestClient(app) as client:
                r = client.get(f"/mocks/{v2}/diff/{v1}", headers=_h(seeded["u_a"]))
                assert r.status_code == 200
                d = r.json()["data"]
                assert (d["from_version"], d["to_version"]) == (1, 2)
                assert d["identical"] is False
                # 実コンテンツ由来の行が diff に現れる
                assert "-<h1>旧見出し</h1>" in d["diff"]
                assert "+<h1>新見出し</h1>" in d["diff"]
                assert "+<p>追加の段落</p>" in d["diff"]
                assert d["added"] == 2 and d["removed"] == 1
                # 同一版どうしは identical
                r_same = client.get(f"/mocks/{v1}/diff/{v1}", headers=_h(seeded["u_a"]))
                assert r_same.status_code == 200
                assert r_same.json()["data"]["identical"] is True
                # 別画面チェーンは比較不可 (409)
                assert (
                    client.get(
                        f"/mocks/{v2}/diff/{other_screen}", headers=_h(seeded["u_a"])
                    ).status_code
                    == 409
                )
                # 他 workspace ユーザーには RLS で不可視 (404)
                assert (
                    client.get(f"/mocks/{v2}/diff/{v1}", headers=_h(seeded["u_b"])).status_code
                    == 404
                )
        finally:
            asyncio.run(test_engine.dispose())
            with sync_engine.begin() as c:
                c.execute(
                    text("delete from public.mocks where project_id = cast(:p as uuid)"),
                    {"p": seeded["proj_a"]},
                )

    def test_concurrent_create_version_raises_conflict(
        self, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """本物の同時改訂: 2 セッションが同じ次版番号を取り合うと後着は
        MockVersionConflict (黙って積み直さない — lost update を隠さない)。"""
        from sqlalchemy.ext.asyncio import create_async_engine

        from src.schemas.mocks import MockVersionCreate
        from src.services import mocks as mocks_svc

        parent = self._seed_mockdb_version(
            sync_engine, project_id=seeded["proj_a"], screen="S-RACE", html=_V1_HTML, version=1
        )

        async def run() -> None:
            eng = create_async_engine(PG_ASYNC, poolclass=NullPool)
            try:
                async with AsyncSession(eng) as sess_a, AsyncSession(eng) as sess_b:
                    created_a = await mocks_svc.create_version(
                        sess_a,
                        actor_id=seeded["u_a"],
                        mock_id=parent,
                        data=MockVersionCreate(html_storage_path="race-a.html"),
                    )
                    assert created_a is not None and created_a.version == 2
                    # B は同じ v2 を計算して insert → A の未コミット行にブロック
                    task = asyncio.create_task(
                        mocks_svc.create_version(
                            sess_b,
                            actor_id=seeded["u_a"],
                            mock_id=parent,
                            data=MockVersionCreate(html_storage_path="race-b.html"),
                        )
                    )
                    await asyncio.sleep(0.6)
                    await sess_a.commit()  # A が先勝ち → B は unique 違反
                    with pytest.raises(mocks_svc.MockVersionConflict):
                        await task
                    await sess_b.rollback()
            finally:
                await eng.dispose()

        try:
            asyncio.run(run())
        finally:
            with sync_engine.begin() as c:
                c.execute(
                    text("delete from public.mocks where project_id = cast(:p as uuid)"),
                    {"p": seeded["proj_a"]},
                )

    def test_conflict_maps_to_409(
        self, app: FastAPI, seeded: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """route 層: MockVersionConflict → HTTP 409 + honest メッセージ。"""
        from src.services import mocks as mocks_svc

        async def _boom(*_a: object, **_k: object) -> None:
            raise mocks_svc.MockVersionConflict(
                "「S-X」は他のメンバーが同時に改訂しました (v2 が先に作成)。"
                "最新を確認して再実行してください"
            )

        monkeypatch.setattr(mocks_svc, "create_version", _boom)
        with TestClient(app) as client:
            r = client.post(
                f"/mocks/{uuid.uuid4()}/versions",
                json={"html_storage_path": "x.html"},
                headers=_h(seeded["u_a"]),
            )
            assert r.status_code == 409
            # GAP-225: 文言は user_messages.py が一元管理する (「同時に改訂されました」→
        # 「ほかの編集と同時に保存されたため…」)。意味は同じで、次の行動まで書く。
        assert "同時に保存された" in r.json()["detail"]
        assert "読み直して" in r.json()["detail"]

    def test_ingest_retries_and_takes_next_version(
        self, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """Bridge 取り込み (新規ファイル由来) は衝突時に version を採り直して
        リトライで吸収する — 人間の改訂と違い 409 で止める相手がいない。"""
        from sqlalchemy.ext.asyncio import create_async_engine

        from src.services.mocks.artifacts import ingest_html_artifact

        async def run() -> None:
            eng = create_async_engine(PG_ASYNC, poolclass=NullPool)
            try:
                async with AsyncSession(eng) as sess_a, AsyncSession(eng) as sess_b:
                    a = await ingest_html_artifact(
                        sess_a,
                        project_id=seeded["proj_a"],
                        file_name="top.html",
                        html="<html><title>TOP</title><body>A</body></html>",
                        source="chat",
                        actor_label="bridge-a",
                    )
                    assert a["version"] == 1
                    # B も v1 を計算して insert → A の未コミット行にブロック →
                    # A commit 後に unique 違反 → 採り直して v2 で成功するはず
                    task = asyncio.create_task(
                        ingest_html_artifact(
                            sess_b,
                            project_id=seeded["proj_a"],
                            file_name="top.html",
                            html="<html><title>TOP</title><body>B</body></html>",
                            source="chat",
                            actor_label="bridge-b",
                        )
                    )
                    await asyncio.sleep(0.6)
                    await sess_a.commit()
                    b = await task
                    assert b["version"] == 2  # リトライで次版を取得 (エラーにしない)
                    await sess_b.commit()
            finally:
                await eng.dispose()

        try:
            asyncio.run(run())
        finally:
            with sync_engine.begin() as c:
                c.execute(
                    text("delete from public.mocks where project_id = cast(:p as uuid)"),
                    {"p": seeded["proj_a"]},
                )
