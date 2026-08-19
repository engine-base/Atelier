"""GAP-137: 成果物 → モック自動反映の統合テスト (実 Postgres + X-Bridge-Token)。

Bridge が送る POST /chat-relay/{job}/artifacts の取り込み (mocks 行 +
mockdb コンテンツ + artifact chunk)、バージョン連鎖、mockdb 閲覧 URL と
GET /mocks/{id}/content の配信を検証する。
"""
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Iterator

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
BRIDGE_TOKEN = "test-bridge-token-secret"
os.environ["ATELIER_BRIDGE_TOKEN"] = BRIDGE_TOKEN
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

import sqlalchemy  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.services import chat_relay  # noqa: E402
from src.services.mocks.artifacts import build_content_url  # noqa: E402


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

    async def _override() -> object:
        async with AsyncSession(test_engine) as session:
            try:
                yield session
            except Exception:
                await session.rollback()
                raise
            else:
                await session.commit()

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from src.routes import api_router
    from src.routes import mocks as mocks_routes
    from src.routes import outputs as outputs_routes
    from src.routes.dispatcher import get_bridge_session

    # GAP-137/139: mockdb 配信は自前 session factory — テスト PG に向ける
    factory = lambda: async_sessionmaker(test_engine, class_=AsyncSession)  # noqa: E731
    monkeypatch.setattr(mocks_routes, "_content_session_factory", factory)
    monkeypatch.setattr(outputs_routes, "_content_session_factory", factory)

    application = FastAPI()
    application.include_router(api_router)
    application.dependency_overrides[get_bridge_session] = _override
    yield application
    asyncio.run(test_engine.dispose())


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    u_a = str(uuid.uuid4())
    ws = str(uuid.uuid4())
    proj = str(uuid.uuid4())
    thread = str(uuid.uuid4())
    with sync_engine.begin() as c:
        em = f"artifact-{u_a[:8]}@t.invalid"
        c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": u_a, "e": em})
        c.execute(text("insert into public.users (id,email) values (:i,:e)"), {"i": u_a, "e": em})
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,'art-ws')"),
            {"i": ws, "o": u_a},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type,status) "
                "values (cast(:i as uuid),cast(:w as uuid),'ArtProj','internal_product','active')"
            ),
            {"i": proj, "w": ws},
        )
        emp = c.execute(
            text("select id from public.ai_employees where workspace_id=cast(:w as uuid) limit 1"),
            {"w": ws},
        ).scalar_one()
        c.execute(
            text(
                "insert into public.chat_threads (id,project_id,ai_employee_id,title) "
                "values (cast(:i as uuid),cast(:p as uuid),cast(:e as uuid),'art-t')"
            ),
            {"i": thread, "p": proj, "e": str(emp)},
        )
    yield {"u_a": u_a, "ws": ws, "proj": proj, "thread": thread}
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.chat_relay_jobs where thread_id=cast(:t as uuid)"),
            {"t": thread},
        )
        c.execute(
            text(
                "delete from public.mock_contents where id in ("
                "  select substring(html_storage_path from 10)::uuid from public.mocks "
                "  where project_id=cast(:p as uuid) and html_storage_path like 'mockdb://%')"
            ),
            {"p": proj},
        )
        c.execute(text("delete from public.mocks where project_id=cast(:p as uuid)"), {"p": proj})
        c.execute(text("delete from public.chat_threads where id=cast(:i as uuid)"), {"i": thread})
        c.execute(text("delete from public.projects where id=cast(:i as uuid)"), {"i": proj})
        c.execute(text("delete from public.workspaces where id=cast(:i as uuid)"), {"i": ws})
        c.execute(text("delete from public.users where id=cast(:i as uuid)"), {"i": u_a})
        c.execute(text("delete from auth.users where id=cast(:i as uuid)"), {"i": u_a})


HEADERS = {"X-Bridge-Token": BRIDGE_TOKEN}


def _enqueue_and_pick(client: TestClient, seeded: dict[str, str]) -> str:
    async def _run() -> str:
        eng = create_async_engine(PG_ASYNC, poolclass=NullPool)
        try:
            async with AsyncSession(eng) as s:
                job_id = await chat_relay.enqueue_job(
                    s,
                    thread_id=seeded["thread"],
                    requested_by=seeded["u_a"],
                    system_prompt="sys",
                    prompt="LP作って",
                    tools_mode="auto",
                )
                await s.commit()
                return job_id
        finally:
            await eng.dispose()

    job_id = asyncio.run(_run())
    picked = client.post("/chat-relay/pick", json={"worker_id": "w1"}, headers=HEADERS)
    assert picked.status_code == 200
    assert picked.json()["data"]["job_id"] == job_id
    return job_id


@pytest.mark.integration
def test_artifacts_ingest_creates_mock_and_chunk(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    with TestClient(app) as client:
        job_id = _enqueue_and_pick(client, seeded)
        res = client.post(
            f"/chat-relay/{job_id}/artifacts",
            json={
                "artifacts": [
                    {
                        "file_name": "lp.html",
                        "html": "<html><title>LP</title><body>v1</body></html>",
                    }
                ]
            },
            headers=HEADERS,
        )
        assert res.status_code == 200
        data = res.json()["data"]
        assert len(data) == 1
        assert data[0]["screen_name"] == "LP"
        assert data[0]["version"] == 1
        mock_id = data[0]["mock_id"]

    with sync_engine.connect() as c:
        row = c.execute(
            text(
                "select html_storage_path, project_id::text as pid from public.mocks "
                "where id=cast(:i as uuid)"
            ),
            {"i": mock_id},
        ).one()
        assert row.pid == seeded["proj"]
        assert row.html_storage_path.startswith("mockdb://")
        html = c.execute(
            text("select html from public.mock_contents where id = cast(:i as uuid)"),
            {"i": row.html_storage_path[len("mockdb://") :]},
        ).scalar_one()
        assert "v1" in html
        chunk = c.execute(
            text(
                "select kind, content from public.chat_relay_chunks "
                "where job_id=cast(:j as uuid) and kind='artifact'"
            ),
            {"j": job_id},
        ).one()
        assert mock_id in chunk.content


@pytest.mark.integration
def test_artifacts_same_screen_chains_versions(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as client:
        job1 = _enqueue_and_pick(client, seeded)
        first = client.post(
            f"/chat-relay/{job1}/artifacts",
            json={"artifacts": [{"file_name": "lp.html", "html": "<title>LP</title>v1"}]},
            headers=HEADERS,
        ).json()["data"][0]
        client.post(f"/chat-relay/{job1}/complete", json={"ok": True}, headers=HEADERS)

        job2 = _enqueue_and_pick(client, seeded)
        second = client.post(
            f"/chat-relay/{job2}/artifacts",
            json={"artifacts": [{"file_name": "lp.html", "html": "<title>LP</title>v2"}]},
            headers=HEADERS,
        ).json()["data"][0]
        assert second["screen_name"] == "LP"
        assert second["version"] == first["version"] + 1


@pytest.mark.integration
def test_artifacts_rejected_unless_running(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as client:
        job_id = _enqueue_and_pick(client, seeded)
        client.post(f"/chat-relay/{job_id}/complete", json={"ok": True}, headers=HEADERS)
        res = client.post(
            f"/chat-relay/{job_id}/artifacts",
            json={"artifacts": [{"file_name": "x.html", "html": "<html/>"}]},
            headers=HEADERS,
        )
        assert res.status_code == 409  # done へは積めない


@pytest.mark.integration
def test_mockdb_content_served_with_signed_url(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as client:
        job_id = _enqueue_and_pick(client, seeded)
        mock_id = client.post(
            f"/chat-relay/{job_id}/artifacts",
            json={
                "artifacts": [
                    {"file_name": "lp.html", "html": "<html><title>LP</title>SIGNED-BODY</html>"}
                ]
            },
            headers=HEADERS,
        ).json()["data"][0]["mock_id"]

        url = build_content_url("http://testserver/", mock_id)
        path = url[len("http://testserver") :]
        ok = client.get(path)
        assert ok.status_code == 200
        assert "SIGNED-BODY" in ok.text
        assert ok.headers["content-type"].startswith("text/html")

        # 改竄トークンは 403
        bad = client.get(path.replace("sig=", "sig=00"))
        assert bad.status_code == 403


@pytest.mark.integration
def test_artifacts_estimate_routes_to_workflow_outputs(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    """GAP-139: 見積 HTML はモックではなく成果物 (workflow_outputs) に入る。"""
    with TestClient(app) as client:
        job_id = _enqueue_and_pick(client, seeded)
        res = client.post(
            f"/chat-relay/{job_id}/artifacts",
            json={
                "artifacts": [
                    {
                        "file_name": "quote.html",
                        "html": "<html><title>お見積書</title><body>合計 100 万円</body></html>",
                    }
                ]
            },
            headers=HEADERS,
        )
        assert res.status_code == 200, res.text
        data = res.json()["data"][0]
        assert data["type"] == "output"
        assert data["stage"] == "estimate"
        assert data["title"] == "お見積書"
        assert data["version"] == 1
        output_id = data["output_id"]

        # 成果物 content endpoint が実 HTML を配信 (自己署名 URL)
        url = build_content_url("http://testserver/", output_id, resource="outputs")
        page = client.get(url[len("http://testserver") :])
        assert page.status_code == 200
        assert "合計 100 万円" in page.text

    with sync_engine.connect() as c:
        row = c.execute(
            text(
                "select stage::text as stage, html_path, summary from public.workflow_outputs "
                "where id = cast(:i as uuid)"
            ),
            {"i": output_id},
        ).one()
        assert row.stage == "estimate"
        assert row.html_path.startswith("mockdb://")
        assert row.summary == "お見積書"
        # モック側には入っていない (仕分けの証明)
        n = c.execute(
            text(
                "select count(*) from public.mocks "
                "where project_id = cast(:p as uuid) and screen_name = 'お見積書'"
            ),
            {"p": seeded["proj"]},
        ).scalar_one()
        assert n == 0
    # 掃除 (seeded の teardown は mocks 側のみ削除するため)
    with sync_engine.begin() as c:
        c.execute(
            text(
                "delete from public.mock_contents where id = ("
                "  select substring(html_path from 10)::uuid from public.workflow_outputs "
                "  where id = cast(:i as uuid))"
            ),
            {"i": output_id},
        )
        c.execute(
            text("delete from public.workflow_outputs where id = cast(:i as uuid)"),
            {"i": output_id},
        )


@pytest.mark.integration
def test_workspace_seed_returns_latest_versions(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    """GAP-141: seed はモック各画面の最新版 + mockdb 成果物を返す。"""
    with TestClient(app) as client:
        # v1 → v2 と作り、seed が v2 (最新) を返すことを確認
        job1 = _enqueue_and_pick(client, seeded)
        client.post(
            f"/chat-relay/{job1}/artifacts",
            json={"artifacts": [{"file_name": "lp.html", "html": "<title>LP</title>v1"}]},
            headers=HEADERS,
        )
        client.post(f"/chat-relay/{job1}/complete", json={"ok": True}, headers=HEADERS)
        job2 = _enqueue_and_pick(client, seeded)
        client.post(
            f"/chat-relay/{job2}/artifacts",
            json={"artifacts": [{"file_name": "lp.html", "html": "<title>LP</title>v2-latest"}]},
            headers=HEADERS,
        )
        client.post(f"/chat-relay/{job2}/complete", json={"ok": True}, headers=HEADERS)

        job3 = _enqueue_and_pick(client, seeded)
        res = client.get(f"/chat-relay/{job3}/workspace", headers=HEADERS)
        assert res.status_code == 200
        files = res.json()["data"]
        assert len(files) == 1
        assert files[0]["file_name"] == "lp.html"
        assert "v2-latest" in files[0]["html"]  # 最新版のみ

        res401 = client.get(f"/chat-relay/{job3}/workspace")
        assert res401.status_code == 401


@pytest.mark.integration
def test_workspace_seed_mixes_html_and_binary_files(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    """GAP-169: HTML とバイナリ (Excel/PDF 等) が混ざった seed が壊れずに配られる。

    以前は route が html 決め打ちで組み立てていたため、base64 のファイル成果物が
    1 つでも混ざると KeyError で 500 になり、**作業場 seed 全体が配られなかった**
    (= Excel/PDF が本人の PC に届かず GAP-166 が成立しない)。実 Bridge 往復で検出。
    """
    import base64 as b64

    xlsx = b"PK\x03\x04" + bytes(range(64))  # 実体はここでは中身を問わない
    with TestClient(app) as client:
        # HTML モック + バイナリ (xlsx) の 2 種を取り込む
        job1 = _enqueue_and_pick(client, seeded)
        client.post(
            f"/chat-relay/{job1}/artifacts",
            json={
                "artifacts": [
                    {"file_name": "lp.html", "html": "<title>LP</title>seed"},
                    {"file_name": "見積.xlsx", "content_b64": b64.b64encode(xlsx).decode()},
                ]
            },
            headers=HEADERS,
        )
        client.post(f"/chat-relay/{job1}/complete", json={"ok": True}, headers=HEADERS)

        job2 = _enqueue_and_pick(client, seeded)
        res = client.get(f"/chat-relay/{job2}/workspace", headers=HEADERS)
        assert res.status_code == 200, res.text  # 500 にならないこと (本丸)
        files = {f["file_name"]: f for f in res.json()["data"]}
        assert "lp.html" in files
        assert "見積.xlsx" in files
        # 使わない側は null ではなく省略して返す (受け手が null を値と誤読しないため)
        assert "content_b64" not in files["lp.html"]
        assert "html" not in files["見積.xlsx"]
        assert b64.b64decode(files["見積.xlsx"]["content_b64"]) == xlsx


@pytest.mark.integration
def test_artifacts_binary_file_ingest_and_serving(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    """GAP-145: バイナリ成果物 (PNG) は workflow_outputs (filedb) に入り実 MIME で配信される。"""
    import base64 as b64

    png = b"\x89PNG\r\n\x1a\n" + bytes(range(48))
    with TestClient(app) as client:
        job_id = _enqueue_and_pick(client, seeded)
        res = client.post(
            f"/chat-relay/{job_id}/artifacts",
            json={
                "artifacts": [
                    {"file_name": "logo.png", "content_b64": b64.b64encode(png).decode()},
                    # 対応外拡張子は誠実に拒否される (下の別ジョブで検証するため未混在)
                ]
            },
            headers=HEADERS,
        )
        assert res.status_code == 200, res.text
        data = res.json()["data"][0]
        assert data["type"] == "file"
        assert data["file_kind"] == "image"
        assert data["stage"] == "design"  # キーワード無し画像の既定
        assert data["title"] == "logo.png"
        assert data["version"] == 1
        output_id = data["output_id"]

        # filedb 配信: bytes 一致 + 実 MIME + inline / dl=1 で attachment
        url = build_content_url("http://testserver/", output_id, resource="outputs")
        page = client.get(url[len("http://testserver") :])
        assert page.status_code == 200
        assert page.content == png
        assert page.headers["content-type"].startswith("image/png")
        assert "inline" in page.headers["content-disposition"]
        dl = client.get(url[len("http://testserver") :] + "&dl=1")
        assert "attachment" in dl.headers["content-disposition"]

    with sync_engine.connect() as c:
        # chunk (kind=artifact) にも type=file が積まれている
        chunk = c.execute(
            text(
                "select content from public.chat_relay_chunks "
                "where job_id=cast(:j as uuid) and kind='artifact'"
            ),
            {"j": job_id},
        ).one()
        assert '"type": "file"' in chunk.content and '"file_kind": "image"' in chunk.content
        row = c.execute(
            text(
                "select stage::text as stage, html_path, meta ->> 'mime' as mime "
                "from public.workflow_outputs where id = cast(:i as uuid)"
            ),
            {"i": output_id},
        ).one()
        assert row.stage == "design"
        assert row.html_path.startswith("filedb://")
        assert row.mime == "image/png"
    with sync_engine.begin() as c:
        c.execute(
            text(
                "delete from public.artifact_files where id = ("
                "  select substring(html_path from 10)::uuid from public.workflow_outputs "
                "  where id = cast(:i as uuid))"
            ),
            {"i": output_id},
        )
        c.execute(
            text("delete from public.workflow_outputs where id = cast(:i as uuid)"),
            {"i": output_id},
        )


@pytest.mark.integration
def test_artifacts_unsupported_extension_rejected(app: FastAPI, seeded: dict[str, str]) -> None:
    """GAP-145: 対応外拡張子 (exe 等) は黙って捨てず 4xx で誠実に拒否する。"""
    import base64 as b64

    with TestClient(app) as client:
        job_id = _enqueue_and_pick(client, seeded)
        res = client.post(
            f"/chat-relay/{job_id}/artifacts",
            json={
                "artifacts": [
                    {"file_name": "app.exe", "content_b64": b64.b64encode(b"MZ").decode()}
                ]
            },
            headers=HEADERS,
        )
        assert res.status_code in (400, 409, 422), res.text


@pytest.mark.integration
def test_artifacts_estimate_named_file_routes_by_filename(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    """GAP-145: 見積 xlsx はファイル名キーワードで stage=estimate に入る。"""
    import base64 as b64

    with TestClient(app) as client:
        job_id = _enqueue_and_pick(client, seeded)
        res = client.post(
            f"/chat-relay/{job_id}/artifacts",
            json={
                "artifacts": [
                    {
                        "file_name": "見積書.xlsx",
                        "content_b64": b64.b64encode(b"PK-fake-xlsx").decode(),
                    }
                ]
            },
            headers=HEADERS,
        )
        assert res.status_code == 200, res.text
        data = res.json()["data"][0]
        assert data["type"] == "file"
        assert data["stage"] == "estimate"
        assert data["file_kind"] == "sheet"
        output_id = data["output_id"]
    with sync_engine.begin() as c:
        c.execute(
            text(
                "delete from public.artifact_files where id = ("
                "  select substring(html_path from 10)::uuid from public.workflow_outputs "
                "  where id = cast(:i as uuid))"
            ),
            {"i": output_id},
        )
        c.execute(
            text("delete from public.workflow_outputs where id = cast(:i as uuid)"),
            {"i": output_id},
        )
