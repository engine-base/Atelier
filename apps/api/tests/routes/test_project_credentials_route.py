"""GAP-278 (通し J31-07 / J39-01): 認可 (viewer 403) は鍵の設定検査より先。

fixture は test_tasks (app / sync_engine / seeded) を再利用する。
"""

# ruff: noqa: F811  -- fixture 名は test_tasks からの import と一致させる必要がある
from __future__ import annotations

import os

import pytest
import sqlalchemy
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

from tests.routes.test_tasks import _h, app, seeded, sync_engine  # noqa: F401

pytestmark = pytest.mark.integration


def test_gap278_viewer_gets_403_even_when_vault_key_is_missing(
    app: FastAPI,
    sync_engine: sqlalchemy.Engine,
    seeded: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from src.services import project_credentials as svc

    monkeypatch.delenv("ATELIER_VAULT_ENCRYPTION_KEYS", raising=False)
    monkeypatch.delenv("ATELIER_VAULT_ENCRYPTION_KEY", raising=False)
    svc._fernet.cache_clear()  # pyright: ignore[reportPrivateUsage]
    with sync_engine.begin() as c:
        c.execute(
            text(
                "insert into public.workspace_memberships (workspace_id, user_id, role) "
                "values (cast(:w as uuid), cast(:u as uuid), 'viewer') on conflict do nothing"
            ),
            {"w": seeded["ws_a"], "u": seeded["u_b"]},
        )
    try:
        with TestClient(app) as client:
            r = client.post(
                f"/projects/{seeded['proj_a']}/credentials",
                json={"name": "API KEY", "kind": "api_key", "value": "sk-test-1234"},
                headers=_h(seeded["u_b"]),
            )
            assert r.status_code == 403, r.text
            assert "権限" in r.json()["detail"]
    finally:
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "delete from public.workspace_memberships where workspace_id = cast(:w as uuid) "
                    "and user_id = cast(:u as uuid)"
                ),
                {"w": seeded["ws_a"], "u": seeded["u_b"]},
            )
        svc._fernet.cache_clear()  # pyright: ignore[reportPrivateUsage]
        _ = os
