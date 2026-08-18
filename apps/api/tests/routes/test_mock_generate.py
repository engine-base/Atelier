"""GAP-138: /mocks/generate (新規モック生成) + mockdb revise の統合テスト。

実 Postgres + RLS + JWT。LLM は ATELIER_ALLOW_FAKE_LLM=1 の決定的スタブ
(チェーンの fake 経路) — 配線と版連鎖・mockdb 保存を検証する。
"""
# pyright: reportUnknownMemberType=false

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
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool  # noqa: E402

from src.dependencies import CurrentUser, get_current_user, get_rls_session  # noqa: E402
from src.services.mocks import artifacts as artifacts_svc  # noqa: E402


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
def app(monkeypatch: pytest.MonkeyPatch) -> Iterator[FastAPI]:
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
    from src.routes import mocks as mocks_routes

    # GAP-138: mock_contents の service 経路をテスト PG へ向ける
    factory = async_sessionmaker(test_engine, class_=AsyncSession)
    monkeypatch.setattr(artifacts_svc, "service_session_factory", lambda: factory)
    monkeypatch.setattr(mocks_routes, "_content_session_factory", lambda: factory)
    # LLM は fake 経路 (他プロバイダは無効)
    monkeypatch.setenv("ATELIER_ALLOW_FAKE_LLM", "1")
    monkeypatch.delenv("ATELIER_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

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
    u = str(uuid.uuid4())
    ws = str(uuid.uuid4())
    proj = str(uuid.uuid4())
    with sync_engine.begin() as c:
        em = f"gen-{u[:8]}@t.invalid"
        c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": u, "e": em})
        c.execute(text("insert into public.users (id,email) values (:i,:e)"), {"i": u, "e": em})
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,'gen-ws')"),
            {"i": ws, "o": u},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type,status) "
                "values (cast(:i as uuid),cast(:w as uuid),'GenProj','internal_product','active')"
            ),
            {"i": proj, "w": ws},
        )
    yield {"u": u, "ws": ws, "proj": proj}
    with sync_engine.begin() as c:
        c.execute(
            text(
                "delete from public.mock_contents where id in ("
                "  select substring(html_storage_path from 10)::uuid from public.mocks "
                "  where project_id=cast(:p as uuid) and html_storage_path like 'mockdb://%')"
            ),
            {"p": proj},
        )
        c.execute(text("delete from public.mocks where project_id=cast(:p as uuid)"), {"p": proj})
        c.execute(text("delete from public.projects where id=cast(:i as uuid)"), {"i": proj})
        c.execute(text("delete from public.workspaces where id=cast(:i as uuid)"), {"i": ws})
        c.execute(text("delete from public.users where id=cast(:i as uuid)"), {"i": u})
        c.execute(text("delete from auth.users where id=cast(:i as uuid)"), {"i": u})


@pytest.mark.integration
def test_generate_creates_mockdb_mock_and_chains_versions(
    app: FastAPI, seeded: dict[str, str]
) -> None:
    h = {"Authorization": f"Bearer {_mint_jwt(seeded['u'])}"}
    with TestClient(app) as client:
        r = client.post(
            "/mocks/generate",
            json={
                "project_id": seeded["proj"],
                "screen_name": "LP トップ",
                "instruction": "タスク管理 SaaS の LP を作って",
            },
            headers=h,
        )
        assert r.status_code == 201, r.text
        v1 = r.json()["data"]
        assert v1["screen_name"] == "LP トップ"
        assert v1["version"] == 1
        assert v1["html_storage_path"].startswith("mockdb://")
        assert v1["meta_tags"]["author"] == "wanda"
        assert v1["meta_tags"]["model"] == "fake"

        # content-url は mockdb の自己署名 URL (storage 未設定でも 200)
        cu = client.get(f"/mocks/{v1['id']}/content-url", headers=h)
        assert cu.status_code == 200
        url = cu.json()["data"]["url"]
        assert f"/mocks/{v1['id']}/content?exp=" in url
        page = client.get(url[url.index("/mocks/") :])
        assert page.status_code == 200
        assert "data-fake-generated" in page.text  # fake 経路の実 HTML

        # 同名で再生成 → v2 連鎖
        r2 = client.post(
            "/mocks/generate",
            json={
                "project_id": seeded["proj"],
                "screen_name": "LP トップ",
                "instruction": "ヒーローを刷新して作り直して",
            },
            headers=h,
        )
        assert r2.status_code == 201
        v2 = r2.json()["data"]
        assert v2["version"] == 2
        assert v2["parent_mock_id"] == v1["id"]


@pytest.mark.integration
def test_generate_auth_and_visibility(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/mocks/generate",
            json={"project_id": seeded["proj"], "instruction": "x"},
        )
        assert r.status_code == 401
        other = str(uuid.uuid4())
        r2 = client.post(
            "/mocks/generate",
            json={"project_id": other, "instruction": "x"},
            headers={"Authorization": f"Bearer {_mint_jwt(seeded['u'])}"},
        )
        assert r2.status_code == 404  # 不可視 project は存在ごと秘匿


@pytest.mark.integration
def test_generate_unconfigured_llm_is_503(
    app: FastAPI, seeded: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ATELIER_ALLOW_FAKE_LLM", raising=False)
    with TestClient(app) as client:
        r = client.post(
            "/mocks/generate",
            json={"project_id": seeded["proj"], "instruction": "x"},
            headers={"Authorization": f"Bearer {_mint_jwt(seeded['u'])}"},
        )
        assert r.status_code == 503


@pytest.mark.integration
def test_revise_on_mockdb_mock_stays_in_mockdb(app: FastAPI, seeded: dict[str, str]) -> None:
    """GAP-138: mockdb モックの編集 (Open Design) も mockdb に新版を作る。"""
    h = {"Authorization": f"Bearer {_mint_jwt(seeded['u'])}"}
    with TestClient(app) as client:
        v1 = client.post(
            "/mocks/generate",
            json={
                "project_id": seeded["proj"],
                "screen_name": "設定画面",
                "instruction": "設定画面を作って",
            },
            headers=h,
        ).json()["data"]
        r = client.post(
            f"/mocks/{v1['id']}/revise",
            json={"instruction": "保存ボタンを右上に"},
            headers=h,
        )
        assert r.status_code == 201, r.text
        v2 = r.json()["data"]
        assert v2["version"] == 2
        assert v2["html_storage_path"].startswith("mockdb://")
        assert v2["html_storage_path"] != v1["html_storage_path"]
        # 新版の実体に fake 改訂バナー (実際に中身が変わった証拠)
        cu = client.get(f"/mocks/{v2['id']}/content-url", headers=h).json()["data"]["url"]
        page = client.get(cu[cu.index("/mocks/") :])
        assert page.status_code == 200
        assert "data-fake-revision" in page.text


@pytest.mark.integration
def test_content_sel_param_injects_selection_script(app: FastAPI, seeded: dict[str, str]) -> None:
    """GAP-142: sel=1 のときだけ要素選択スクリプトが注入される。"""
    h = {"Authorization": f"Bearer {_mint_jwt(seeded['u'])}"}
    with TestClient(app) as client:
        mock = client.post(
            "/mocks/generate",
            json={
                "project_id": seeded["proj"],
                "screen_name": "選択検証",
                "instruction": "画面を作って",
            },
            headers=h,
        ).json()["data"]
        url = client.get(f"/mocks/{mock['id']}/content-url", headers=h).json()["data"]["url"]
        path = url[url.index("/mocks/") :]
        plain = client.get(path)
        assert plain.status_code == 200
        assert "data-atelier-select" not in plain.text
        injected = client.get(f"{path}&sel=1")
        assert injected.status_code == 200
        assert "data-atelier-select" in injected.text
        assert "atelier-element-selected" in injected.text


@pytest.mark.integration
def test_design_note_roundtrip_and_injection(
    app: FastAPI, seeded: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """GAP-143: ノート保存 → 生成 system prompt に自動注入される。"""
    h = {"Authorization": f"Bearer {_mint_jwt(seeded['u'])}"}
    with TestClient(app) as client:
        # 初期は空
        r = client.get(f"/projects/{seeded['proj']}/design-note", headers=h)
        assert r.status_code == 200
        assert r.json()["data"]["note"] == ""
        # 保存
        r2 = client.put(
            f"/projects/{seeded['proj']}/design-note",
            json={"note": "- メインカラーは紺 #1e3a5f\n- 角丸は大きめ"},
            headers=h,
        )
        assert r2.status_code == 200
        assert (
            "紺"
            in client.get(f"/projects/{seeded['proj']}/design-note", headers=h).json()["data"][
                "note"
            ]
        )

        # 生成時に system prompt へ注入されることを llm_complete 差し替えで実測
        captured: dict[str, str] = {}

        async def _fake_complete(**kwargs: object) -> tuple[str, str]:
            captured["system"] = str(kwargs["system_prompt"])
            return "<!doctype html><html><title>注入検証</title></html>", "fake"

        from src.services.chat_sse import llm_chain

        monkeypatch.setattr(llm_chain, "llm_complete", _fake_complete)
        r3 = client.post(
            "/mocks/generate",
            json={
                "project_id": seeded["proj"],
                "screen_name": "注入検証",
                "instruction": "画面を作って",
            },
            headers=h,
        )
        assert r3.status_code == 201, r3.text
        assert "デザインノート (必ず従うこと)" in captured["system"]
        assert "#1e3a5f" in captured["system"]

        # 不可視 project は 404 (存在秘匿)
        import uuid as _uuid

        r4 = client.get(f"/projects/{_uuid.uuid4()}/design-note", headers=h)
        assert r4.status_code == 404


@pytest.mark.integration
def test_design_note_learning_appends_and_skips_no_change(
    app: FastAPI, seeded: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """GAP-143: 指示からの自動追記 (fake 経路) と「変化なしは保存しない」。"""
    import asyncio as _asyncio

    from src.services.mocks import design_note as note_svc

    # fake 経路: 既存ノート + 指示の要約が追記される
    assert _asyncio.run(
        note_svc.apply_design_note_learning(
            project_id=seeded["proj"],
            instruction="ボタンは全て角丸 12px にして",
            actor_id=seeded["u"],
        )
    )
    h = {"Authorization": f"Bearer {_mint_jwt(seeded['u'])}"}
    with TestClient(app) as client:
        note = client.get(f"/projects/{seeded['proj']}/design-note", headers=h).json()["data"][
            "note"
        ]
        assert "角丸 12px" in note

    # LLM が既存ノートと同一を返した場合は保存しない (False)
    async def _no_change(**kwargs: object) -> tuple[str, str]:
        return note, "fake"

    from src.services.chat_sse import llm_chain

    monkeypatch.setattr(llm_chain, "llm_complete", _no_change)
    assert not _asyncio.run(
        note_svc.apply_design_note_learning(
            project_id=seeded["proj"], instruction="誤字直して", actor_id=seeded["u"]
        )
    )
