"""Unit tests for GET /meetings/{id}/transcript-url（署名付き閲覧 URL）。"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src import storage_signing
from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.routes.meetings import router
from src.services import meetings as meetings_svc


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="u1", role="authenticated", claims={}
    )
    app.dependency_overrides[get_rls_session] = lambda: SimpleNamespace()
    return app


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = ""

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeClient:
    def __init__(self, *_a: Any, **_k: Any) -> None:
        pass

    async def __aenter__(self) -> _FakeClient:
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False

    async def post(
        self, url: str, headers: dict[str, str] | None = None, json: dict[str, Any] | None = None
    ) -> _FakeResponse:
        return _FakeResponse(
            200, {"signedURL": "/object/sign/transcripts/queued/m1.json?token=abc"}
        )


def _patch_get_meeting(monkeypatch: pytest.MonkeyPatch, result: object) -> None:
    async def _fake(_session: Any, _meeting_id: str) -> object:
        return result

    monkeypatch.setattr(meetings_svc, "get_meeting", _fake)


def test_transcript_url_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "https://proj.supabase.co")
    monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "svc-key")
    monkeypatch.setattr(storage_signing.httpx, "AsyncClient", _FakeClient)
    _patch_get_meeting(monkeypatch, SimpleNamespace(parse_result_path="transcripts/queued/m1.json"))
    with TestClient(_app()) as client:
        res = client.get("/meetings/m1/transcript-url")
    assert res.status_code == 200
    assert res.json()["data"]["url"].endswith("/transcripts/queued/m1.json?token=abc")


def test_transcript_url_409_when_not_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "https://proj.supabase.co")
    monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "svc-key")
    _patch_get_meeting(monkeypatch, SimpleNamespace(parse_result_path=None))
    with TestClient(_app()) as client:
        res = client.get("/meetings/m1/transcript-url")
    assert res.status_code == 409


def test_transcript_url_503_unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ATELIER_SUPABASE_ADMIN_API_URL", raising=False)
    monkeypatch.delenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", raising=False)
    _patch_get_meeting(monkeypatch, SimpleNamespace(parse_result_path="transcripts/queued/m1.json"))
    with TestClient(_app()) as client:
        res = client.get("/meetings/m1/transcript-url")
    assert res.status_code == 503


def test_transcript_url_404_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "https://proj.supabase.co")
    monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "svc-key")
    _patch_get_meeting(monkeypatch, None)
    with TestClient(_app()) as client:
        res = client.get("/meetings/missing/transcript-url")
    assert res.status_code == 404
