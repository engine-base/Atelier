"""GAP-298: proxy 越しでも自己署名 URL が https で組み立てられる。"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from src.routes.public_url import public_base_url


def _app() -> FastAPI:
    app = FastAPI()

    @app.get("/probe")
    async def probe(request: Request) -> dict[str, str]:
        return {"base": public_base_url(request)}

    return app


def test_forwarded_proto_makes_https(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ATELIER_PUBLIC_BASE_URL", raising=False)
    with TestClient(_app(), base_url="http://atelier-api-eb.fly.dev") as client:
        plain = client.get("/probe").json()["base"]
        assert plain == "http://atelier-api-eb.fly.dev/"
        fwd = client.get("/probe", headers={"x-forwarded-proto": "https"}).json()["base"]
        assert fwd == "https://atelier-api-eb.fly.dev/"
        host = client.get(
            "/probe", headers={"x-forwarded-proto": "https", "x-forwarded-host": "api.example.com"}
        ).json()["base"]
        assert host == "https://api.example.com/"


def test_explicit_public_base_url_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATELIER_PUBLIC_BASE_URL", "https://api.atelier.example")
    with TestClient(_app(), base_url="http://internal") as client:
        assert client.get("/probe").json()["base"] == "https://api.atelier.example/"
