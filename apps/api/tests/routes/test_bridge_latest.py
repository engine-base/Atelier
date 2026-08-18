"""GAP-135: /public/bridge-latest (Bridge 更新チェックフィード) の unit tests。

DB を使わない env 駆動エンドポイントなので実 Postgres 不要。
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.routes.public import router


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_bridge_latest_defaults_to_no_update(monkeypatch: pytest.MonkeyPatch) -> None:
    """env 未設定 = 現行版 0.1.0 / URL 無し (Bridge 側は「更新なし」と判定する)。"""
    for key in (
        "ATELIER_BRIDGE_LATEST_VERSION",
        "ATELIER_BRIDGE_DOWNLOAD_URL_MAC",
        "ATELIER_BRIDGE_DOWNLOAD_URL_WIN",
        "ATELIER_BRIDGE_DOWNLOAD_URL_LINUX",
    ):
        monkeypatch.delenv(key, raising=False)
    res = _client().get("/public/bridge-latest")
    assert res.status_code == 200
    assert res.json() == {"data": {"version": "0.1.0", "download_urls": {}}}


def test_bridge_latest_serves_configured_release(monkeypatch: pytest.MonkeyPatch) -> None:
    """リリース = env 更新のみ。設定済み OS だけが download_urls に載る。"""
    monkeypatch.setenv("ATELIER_BRIDGE_LATEST_VERSION", "0.2.0")
    monkeypatch.setenv("ATELIER_BRIDGE_DOWNLOAD_URL_MAC", "https://dl.example/bridge.dmg")
    monkeypatch.setenv("ATELIER_BRIDGE_DOWNLOAD_URL_WIN", "https://dl.example/bridge.exe")
    monkeypatch.setenv("ATELIER_BRIDGE_DOWNLOAD_URL_LINUX", "  ")  # 空白のみ = 未設定扱い
    res = _client().get("/public/bridge-latest")
    assert res.status_code == 200
    assert res.json() == {
        "data": {
            "version": "0.2.0",
            "download_urls": {
                "mac": "https://dl.example/bridge.dmg",
                "win": "https://dl.example/bridge.exe",
            },
        }
    }
