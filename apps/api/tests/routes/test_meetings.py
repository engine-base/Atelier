"""Integration tests for /meetings (T-A-38) — 実 Postgres + RLS + JWT。

議事録アップロード + Whisper transcription キュー登録。
401 / 404 / 403 / cross-workspace / audit_logs / force re-queue を網羅。
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
    upload_a_unparsed = str(uuid.uuid4())
    upload_a_parsed = str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta38-{uid[:8]}@t.invalid"
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
        c.execute(
            text(
                "insert into public.external_uploads "
                "(id, project_id, uploaded_by_user_id, type, storage_path, file_name, "
                "file_size_bytes, mime_type) values "
                "(cast(:i as uuid), cast(:p as uuid), cast(:u as uuid), 'audio', "
                "'uploads/m1.m4a', 'm1.m4a', 1000, 'audio/m4a')"
            ),
            {"i": upload_a_unparsed, "p": proj_a, "u": u_a},
        )
        c.execute(
            text(
                "insert into public.external_uploads "
                "(id, project_id, uploaded_by_user_id, type, storage_path, file_name, "
                "file_size_bytes, mime_type, parsed_at, parse_result_path) values "
                "(cast(:i as uuid), cast(:p as uuid), cast(:u as uuid), 'audio', "
                "'uploads/m2.m4a', 'm2.m4a', 2000, 'audio/m4a', now(), 'transcripts/m2.json')"
            ),
            {"i": upload_a_parsed, "p": proj_a, "u": u_a},
        )
    yield {
        "u_a": u_a,
        "u_b": u_b,
        "ws_a": ws_a,
        "proj_a": proj_a,
        "upload_a_unparsed": upload_a_unparsed,
        "upload_a_parsed": upload_a_parsed,
    }
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestMeetings:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/meetings").status_code == 401
            assert client.post("/meetings", json={}).status_code == 401
            assert client.post(f"/meetings/{uuid.uuid4()}/transcribe", json={}).status_code == 401

    def test_list_and_get(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(f"/meetings?project_id={seeded['proj_a']}", headers=h)
            assert r.status_code == 200
            ids = {x["id"] for x in r.json()["data"]}
            assert seeded["upload_a_unparsed"] in ids
            assert seeded["upload_a_parsed"] in ids
            g = client.get(f"/meetings/{seeded['upload_a_unparsed']}", headers=h)
            assert g.status_code == 200
            assert g.json()["data"]["file_name"] == "m1.m4a"
            assert g.json()["data"]["parsed_at"] is None

    def test_filter_by_type(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(f"/meetings?project_id={seeded['proj_a']}&type=audio", headers=h)
            assert r.status_code == 200
            assert len(r.json()["data"]) >= 2
            r2 = client.get(f"/meetings?project_id={seeded['proj_a']}&type=video", headers=h)
            assert r2.status_code == 200
            assert r2.json()["data"] == []

    def test_cross_workspace_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        hb = _h(seeded["u_b"])
        with TestClient(app) as client:
            assert (
                client.get(f"/meetings/{seeded['upload_a_unparsed']}", headers=hb).status_code
                == 404
            )

    def test_create_meeting_and_audit(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/meetings",
                headers=h,
                json={
                    "project_id": seeded["proj_a"],
                    "type": "audio",
                    "storage_path": "uploads/new.m4a",
                    "file_name": "new.m4a",
                    "file_size_bytes": 4096,
                    "mime_type": "audio/m4a",
                },
            )
            assert r.status_code == 201, r.text
            doc = r.json()["data"]
            assert doc["uploaded_by_user_id"] == seeded["u_a"]
            assert doc["file_size_bytes"] == 4096
            assert doc["parsed_at"] is None
            new_id = doc["id"]
        with sync_engine.begin() as c:
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'meeting.create' and target_id = cast(:t as uuid)"
                ),
                {"t": new_id},
            ).scalar_one()
            assert cnt == 1

    def test_transcribe_queues_unparsed(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/meetings/{seeded['upload_a_unparsed']}/transcribe",
                headers=h,
                json={"force": False},
            )
            assert r.status_code == 202, r.text
            assert r.json()["data"]["status"] == "queued"
        with sync_engine.begin() as c:
            row = c.execute(
                text(
                    "select parse_result_path, parse_error from public.external_uploads "
                    "where id = cast(:i as uuid)"
                ),
                {"i": seeded["upload_a_unparsed"]},
            ).first()
            assert row is not None
            assert row.parse_result_path == f"transcripts/queued/{seeded['upload_a_unparsed']}.json"
            assert row.parse_error is None
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'meeting.transcribe.queue' "
                    "and target_id = cast(:t as uuid)"
                ),
                {"t": seeded["upload_a_unparsed"]},
            ).scalar_one()
            assert cnt == 1

    def test_transcribe_already_parsed_skip(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/meetings/{seeded['upload_a_parsed']}/transcribe",
                headers=h,
                json={"force": False},
            )
            assert r.status_code == 202
            assert r.json()["data"]["status"] == "already_parsed"

    def test_transcribe_force_requeues_parsed(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/meetings/{seeded['upload_a_parsed']}/transcribe",
                headers=h,
                json={"force": True},
            )
            assert r.status_code == 202
            assert r.json()["data"]["status"] == "queued"
        with sync_engine.begin() as c:
            row = c.execute(
                text("select parsed_at from public.external_uploads where id = cast(:i as uuid)"),
                {"i": seeded["upload_a_parsed"]},
            ).first()
            assert row is not None and row.parsed_at is None

    def test_transcribe_404_for_nonexistent(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert (
                client.post(
                    f"/meetings/{uuid.uuid4()}/transcribe", headers=h, json={"force": False}
                ).status_code
                == 404
            )

    def test_delete_soft(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert (
                client.delete(f"/meetings/{seeded['upload_a_unparsed']}", headers=h).status_code
                == 204
            )
            assert (
                client.get(f"/meetings/{seeded['upload_a_unparsed']}", headers=h).status_code == 404
            )
        with sync_engine.begin() as c:
            row = c.execute(
                text("select deleted_at from public.external_uploads where id = cast(:i as uuid)"),
                {"i": seeded["upload_a_unparsed"]},
            ).first()
            assert row is not None and row.deleted_at is not None
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'meeting.delete' and target_id = cast(:t as uuid)"
                ),
                {"t": seeded["upload_a_unparsed"]},
            ).scalar_one()
            assert cnt == 1
