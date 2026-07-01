"""Unit tests for GET /mocks/{id}/content-url (署名付き閲覧 URL)。

DB を使わず、get_current_user / get_rls_session を override し、svc.get_mock と
storage_signing.httpx をモックして検証する:
  - 設定済 → 200 (署名 URL)
  - storage 未設定 → 503
  - mock 不在 → 404
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src import storage_signing
from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.routes.mocks import router
from src.services import mocks as mocks_svc


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
        return _FakeResponse(200, {"signedURL": "/object/sign/mocks/login-v1.html?token=abc"})


def _patch_get_mock(monkeypatch: pytest.MonkeyPatch, result: object) -> None:
    async def _fake_get_mock(_session: Any, _mock_id: str) -> object:
        return result

    monkeypatch.setattr(mocks_svc, "get_mock", _fake_get_mock)


def test_content_url_returns_signed_url_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "https://proj.supabase.co")
    monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "svc-key")
    monkeypatch.setattr(storage_signing.httpx, "AsyncClient", _FakeClient)
    _patch_get_mock(monkeypatch, SimpleNamespace(html_storage_path="mocks/login-v1.html"))
    with TestClient(_app()) as client:
        res = client.get("/mocks/m1/content-url")
    assert res.status_code == 200
    assert res.json()["data"]["url"] == (
        "https://proj.supabase.co/storage/v1/object/sign/mocks/login-v1.html?token=abc"
    )


def test_content_url_returns_503_when_storage_unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ATELIER_SUPABASE_ADMIN_API_URL", raising=False)
    monkeypatch.delenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", raising=False)
    _patch_get_mock(monkeypatch, SimpleNamespace(html_storage_path="mocks/login-v1.html"))
    with TestClient(_app()) as client:
        res = client.get("/mocks/m1/content-url")
    assert res.status_code == 503


def test_content_url_returns_404_when_mock_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "https://proj.supabase.co")
    monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "svc-key")
    _patch_get_mock(monkeypatch, None)
    with TestClient(_app()) as client:
        res = client.get("/mocks/missing/content-url")
    assert res.status_code == 404
