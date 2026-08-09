"""Unit tests for AI 社員アイコン画像 (GAP-009 / S-C02)。

DB を使わず get_rls_session / get_current_user を override し、
svc.get_ai_employee と httpx をモックして検証する:
  - storage 未設定 → 503 (unconfigured を握り潰さない)
  - MIME/サイズ制約 → 415 / 413 (storage より前に検証)
  - 署名成功 → upload_url + storage_path (avatars/ai-employees/... 規約)
  - icon-url: lucide 名は 409 / path は署名付き URL / 未設定 503
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.routes.ai_employees import router
from src.schemas.ai_employees import AiEmployeeResponse
from src.services import ai_employees as svc

_EMP_ID = "5f0f7f7e-2a65-4bd9-9a54-64ec9f2a3a10"


def _employee(icon: str | None) -> AiEmployeeResponse:
    now = datetime.now(UTC)
    return AiEmployeeResponse(
        id=_EMP_ID,
        workspace_id="11111111-1111-1111-1111-111111111111",
        template_id=None,
        name="tony",
        display_name="トニー",
        icon=icon,
        role="coo",
        department="executive",
        tone_preset="polite",
        custom_tone_text=None,
        attached_skills=[],
        attached_knowledge_cats=[],
        is_default=True,
        archived=False,
        created_at=now,
        updated_at=now,
    )


def _app(monkeypatch: pytest.MonkeyPatch, *, icon: str | None) -> FastAPI:
    async def _fake_get(_session: Any, _employee_id: str) -> AiEmployeeResponse:
        return _employee(icon)

    monkeypatch.setattr(svc, "get_ai_employee", _fake_get)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="u1", role="authenticated", claims={}
    )
    app.dependency_overrides[get_rls_session] = lambda: None
    return app


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.status_code = 200
        self._payload = payload
        self.text = ""

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeClient:
    """httpx.AsyncClient 差し替え (upload sign / download sign 両対応)。"""

    def __init__(self, *_a: Any, **_k: Any) -> None:
        pass

    async def __aenter__(self) -> _FakeClient:
        return self

    async def __aexit__(self, *_a: Any) -> bool:
        return False

    async def post(self, url: str, **_k: Any) -> _FakeResponse:
        if "/object/upload/sign/" in url:
            return _FakeResponse({"url": "/object/upload/sign/avatars/x/icon.png?token=abc"})
        return _FakeResponse({"signedURL": "/object/download/avatars/x/icon.png?token=abc"})


_UPLOAD_BODY = {"file_name": "icon.png", "mime_type": "image/png", "file_size_bytes": 1000}


def _set_storage_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "http://storage.test")
    monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "sk-test")


def _clear_storage_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ATELIER_SUPABASE_ADMIN_API_URL", raising=False)
    monkeypatch.delenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", raising=False)


class TestIconUploadUrl:
    def test_returns_503_when_storage_unconfigured(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _clear_storage_env(monkeypatch)
        with TestClient(_app(monkeypatch, icon=None)) as client:
            res = client.post(f"/ai-employees/{_EMP_ID}/icon-upload-url", json=_UPLOAD_BODY)
        assert res.status_code == 503

    def test_rejects_non_image_mime_415(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _clear_storage_env(monkeypatch)  # MIME 検証は storage より前 (503 にならないこと)
        with TestClient(_app(monkeypatch, icon=None)) as client:
            res = client.post(
                f"/ai-employees/{_EMP_ID}/icon-upload-url",
                json={**_UPLOAD_BODY, "mime_type": "application/pdf"},
            )
        assert res.status_code == 415

    def test_rejects_oversize_413(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _clear_storage_env(monkeypatch)
        with TestClient(_app(monkeypatch, icon=None)) as client:
            res = client.post(
                f"/ai-employees/{_EMP_ID}/icon-upload-url",
                json={**_UPLOAD_BODY, "file_size_bytes": svc.ICON_MAX_BYTES + 1},
            )
        assert res.status_code == 413

    def test_signs_upload_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _set_storage_env(monkeypatch)
        import src.storage_signing as signing

        monkeypatch.setattr(signing.httpx, "AsyncClient", _FakeClient)
        with TestClient(_app(monkeypatch, icon=None)) as client:
            res = client.post(f"/ai-employees/{_EMP_ID}/icon-upload-url", json=_UPLOAD_BODY)
        assert res.status_code == 200, res.text
        data = res.json()["data"]
        assert data["upload_url"].startswith("http://storage.test/storage/v1/")
        assert data["storage_path"].startswith(f"avatars/ai-employees/{_EMP_ID}/")
        assert data["storage_path"].endswith("/icon.png")


class TestIconUrl:
    def test_409_when_icon_is_lucide_name(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _set_storage_env(monkeypatch)
        with TestClient(_app(monkeypatch, icon="rocket")) as client:
            res = client.get(f"/ai-employees/{_EMP_ID}/icon-url")
        assert res.status_code == 409

    def test_409_when_icon_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _set_storage_env(monkeypatch)
        with TestClient(_app(monkeypatch, icon=None)) as client:
            res = client.get(f"/ai-employees/{_EMP_ID}/icon-url")
        assert res.status_code == 409

    def test_503_when_storage_unconfigured(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _clear_storage_env(monkeypatch)
        with TestClient(_app(monkeypatch, icon="avatars/ai-employees/x/icon.png")) as client:
            res = client.get(f"/ai-employees/{_EMP_ID}/icon-url")
        assert res.status_code == 503

    def test_returns_signed_download_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _set_storage_env(monkeypatch)
        import src.storage_signing as signing

        monkeypatch.setattr(signing.httpx, "AsyncClient", _FakeClient)
        with TestClient(_app(monkeypatch, icon="avatars/ai-employees/x/icon.png")) as client:
            res = client.get(f"/ai-employees/{_EMP_ID}/icon-url")
        assert res.status_code == 200, res.text
        assert "/object/download/avatars/" in res.json()["data"]["url"]
