"""Unit tests for GET/PATCH /me（自己プロフィール, T-UC-37）。

DB を使わず get_current_user / get_rls_session を override し、svc をモックする。
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.routes.users import router
from src.schemas.users import MeResponse
from src.services import users as users_svc


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="u1", role="authenticated", claims={}
    )
    app.dependency_overrides[get_rls_session] = lambda: SimpleNamespace()
    return app


def test_get_me_returns_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fake_get_me(_session: Any, user_id: str) -> MeResponse:
        assert user_id == "u1"
        return MeResponse(id="u1", email="a@example.com", display_name="山田")

    monkeypatch.setattr(users_svc, "get_me", _fake_get_me)
    with TestClient(_app()) as client:
        res = client.get("/me")
    assert res.status_code == 200
    assert res.json()["data"] == {"id": "u1", "email": "a@example.com", "display_name": "山田"}


def test_get_me_404_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fake_get_me(_session: Any, _user_id: str) -> None:
        return None

    monkeypatch.setattr(users_svc, "get_me", _fake_get_me)
    with TestClient(_app()) as client:
        res = client.get("/me")
    assert res.status_code == 404


def test_patch_me_updates_display_name(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, str] = {}

    async def _fake_update_me(_session: Any, *, user_id: str, display_name: str) -> MeResponse:
        captured["user_id"] = user_id
        captured["display_name"] = display_name
        return MeResponse(id=user_id, email="a@example.com", display_name=display_name)

    monkeypatch.setattr(users_svc, "update_me", _fake_update_me)
    with TestClient(_app()) as client:
        res = client.patch("/me", json={"display_name": "新しい名前"})
    assert res.status_code == 200
    assert res.json()["data"]["display_name"] == "新しい名前"
    assert captured == {"user_id": "u1", "display_name": "新しい名前"}


def test_patch_me_422_when_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    with TestClient(_app()) as client:
        res = client.patch("/me", json={"display_name": ""})
    assert res.status_code == 422
