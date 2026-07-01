"""Unit tests for POST /meetings/upload-url (T-UC-23 storage 署名付きアップロード)。

DB を使わず、get_current_user を override し svc.httpx をモックして検証する:
  - storage 未設定 → 503
  - 設定済 + storage が署名 URL を返す → 200 (upload_url / storage_path / bucket)
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.dependencies import CurrentUser, get_current_user
from src.routes.meetings import router
from src.services import meetings as svc


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="u1", role="authenticated", claims={}
    )
    return app


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict[str, Any]) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = ""

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeClient:
    """httpx.AsyncClient 差し替え用。post は固定の署名 URL を返す。"""

    def __init__(self, *_a: Any, **_k: Any) -> None:
        pass

    async def __aenter__(self) -> _FakeClient:
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False

    async def post(self, url: str, headers: dict[str, str] | None = None) -> _FakeResponse:
        # object path は末尾。署名 URL は相対で返るのが Supabase Storage の仕様。
        return _FakeResponse(200, {"url": "/object/upload/sign/meetings/p1/xxx/rec.m4a?token=abc"})


def _fake_client_with(status_code: int, payload: dict[str, Any]) -> type:
    class _C(_FakeClient):
        async def post(self, url: str, headers: dict[str, str] | None = None) -> _FakeResponse:
            return _FakeResponse(status_code, payload)

    return _C


_BODY = {"project_id": "p1", "file_name": "rec.m4a", "mime_type": "audio/mp4"}


def test_upload_url_returns_503_when_storage_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ATELIER_SUPABASE_ADMIN_API_URL", raising=False)
    monkeypatch.delenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", raising=False)
    with TestClient(_app()) as client:
        res = client.post("/meetings/upload-url", json=_BODY)
    assert res.status_code == 503


def test_upload_url_returns_signed_url_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "https://proj.supabase.co")
    monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "svc-key")
    monkeypatch.setattr(svc.httpx, "AsyncClient", _FakeClient)
    with TestClient(_app()) as client:
        res = client.post("/meetings/upload-url", json=_BODY)
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["bucket"] == "meetings"
    assert data["storage_path"].startswith("meetings/p1/")
    assert data["storage_path"].endswith("/rec.m4a")
    assert data["upload_url"] == (
        "https://proj.supabase.co/storage/v1/object/upload/sign/meetings/p1/xxx/rec.m4a?token=abc"
    )


def test_upload_url_returns_502_when_storage_signing_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "https://proj.supabase.co")
    monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "svc-key")
    monkeypatch.setattr(svc.httpx, "AsyncClient", _fake_client_with(500, {}))
    with TestClient(_app()) as client:
        res = client.post("/meetings/upload-url", json=_BODY)
    assert res.status_code == 502


def test_upload_url_returns_502_when_signed_url_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "https://proj.supabase.co")
    monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "svc-key")
    monkeypatch.setattr(svc.httpx, "AsyncClient", _fake_client_with(200, {}))
    with TestClient(_app()) as client:
        res = client.post("/meetings/upload-url", json=_BODY)
    assert res.status_code == 502


def test_upload_url_sanitizes_filename(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "https://proj.supabase.co")
    monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "svc-key")
    monkeypatch.setattr(svc.httpx, "AsyncClient", _FakeClient)
    body = {"project_id": "p1", "file_name": "../../etc/passwd", "mime_type": "audio/mp4"}
    with TestClient(_app()) as client:
        res = client.post("/meetings/upload-url", json=body)
    assert res.status_code == 200
    # path traversal 文字は除去され storage_path に "../" が現れない。
    assert ".." not in res.json()["data"]["storage_path"]
