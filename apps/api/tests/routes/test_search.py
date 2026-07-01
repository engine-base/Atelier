"""Tests for /search（横断検索, T-UC-40）。

- サービスの純関数（kinds_for / row_to_hit）は DB 不要で検証。
- ルートは svc.search をモックして 200 / 422 を検証。
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.routes.search import router
from src.schemas.search import SearchHit
from src.services import search as search_svc


def test_kinds_for_all_returns_every_kind() -> None:
    assert search_svc.kinds_for("all") == ["project", "task", "knowledge", "employee"]


def test_kinds_for_single_and_unknown() -> None:
    assert search_svc.kinds_for("task") == ["task"]
    assert search_svc.kinds_for("bogus") == []


def test_row_to_hit_normalizes_snippet_none() -> None:
    hit = search_svc.row_to_hit("project", SimpleNamespace(id="p1", title="P", snippet=None))
    assert hit == SearchHit(id="p1", kind="project", title="P", snippet="")


def test_row_to_hit_keeps_snippet() -> None:
    hit = search_svc.row_to_hit("task", SimpleNamespace(id="t1", title="T", snippet="詳細"))
    assert hit.snippet == "詳細"
    assert hit.kind == "task"


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="u1", role="authenticated", claims={}
    )
    app.dependency_overrides[get_rls_session] = lambda: SimpleNamespace()
    return app


def test_search_route_returns_hits(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fake_search(_session: Any, *, q: str, kind: str) -> list[SearchHit]:
        assert q == "atelier"
        assert kind == "all"
        return [SearchHit(id="p1", kind="project", title="Atelier", snippet="")]

    monkeypatch.setattr(search_svc, "search", _fake_search)
    with TestClient(_app()) as client:
        res = client.get("/search", params={"q": "atelier"})
    assert res.status_code == 200
    assert res.json()["data"] == [
        {"id": "p1", "kind": "project", "title": "Atelier", "snippet": ""}
    ]


def test_search_route_422_without_q() -> None:
    with TestClient(_app()) as client:
        res = client.get("/search")
    assert res.status_code == 422
