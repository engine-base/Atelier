"""scripts/grant-admin.sh の回帰テスト (GAP-217)。

運営画面に入れるかどうかは `auth.users.raw_app_meta_data->>'role'` だけで決まる。
この script はその 1 列を書き換える唯一の手段なので、壊れると
**新しい環境で誰も運営になれない**（2026-08-26 の通し J00-03 で踏んだ状態）。

特に守りたいのは **jsonb を丸ごと置き換えないこと**。Supabase は同じ列に
`provider` などを入れるため、`raw_app_meta_data = '{"role":"admin"}'` と
書いてしまうと外部サインインの情報が消える。`||` と `-` で role キーだけを
足し引きしていることを、実際に DB を動かして確かめる。

Postgres が無い環境では skip する。
"""

from __future__ import annotations

import json
import os
import subprocess
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
import sqlalchemy
from sqlalchemy import Engine, text
from sqlalchemy.pool import NullPool

_ASYNC_URL = os.environ.get(
    "ATELIER_TEST_PG_URL",
    "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322",
)
PG_SYNC = _ASYNC_URL.replace("+asyncpg", "+psycopg")
#: psql に渡す形 (SQLAlchemy の driver 指定を落とす)
PG_PSQL = _ASYNC_URL.replace("postgresql+asyncpg://", "postgresql://")

SCRIPT = Path(__file__).resolve().parents[3] / "scripts/grant-admin.sh"


def _db_available() -> bool:
    try:
        eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
        try:
            with eng.connect() as c:
                c.execute(text("select 1 from auth.users limit 1"))
        finally:
            eng.dispose()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="Postgres / auth.users not available")


@pytest.fixture
def engine() -> Iterator[Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    try:
        yield eng
    finally:
        eng.dispose()


@pytest.fixture
def user_email(engine: Engine) -> Iterator[str]:
    """外部サインインの情報を既に持っている利用者を 1 人だけ作る。"""
    email = f"grant-admin-test-{uuid.uuid4().hex[:12]}@example.com"
    with engine.begin() as conn:
        conn.execute(
            text(
                "insert into auth.users (id, email, raw_app_meta_data) "
                'values (gen_random_uuid(), :e, \'{"provider":"google"}\'::jsonb)'
            ),
            {"e": email},
        )
    try:
        yield email
    finally:
        with engine.begin() as conn:
            conn.execute(text("delete from auth.users where email = :e"), {"e": email})


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        env={**os.environ, "PGURL": PG_PSQL},
        capture_output=True,
        text=True,
        timeout=60,
    )


def _app_meta(engine: Engine, email: str) -> dict[str, object]:
    with engine.connect() as conn:
        raw = conn.execute(
            text("select raw_app_meta_data from auth.users where email = :e"), {"e": email}
        ).scalar_one()
    return json.loads(raw) if isinstance(raw, str) else dict(raw)


def test_昇格しても既存のキーを消さない(engine: Engine, user_email: str) -> None:
    res = _run(user_email)
    assert res.returncode == 0, res.stderr
    meta = _app_meta(engine, user_email)
    assert meta["role"] == "admin"
    # ここが本題 — jsonb を丸ごと置き換えていたら provider が消える
    assert meta["provider"] == "google"


def test_取り消しでroleだけが外れる(engine: Engine, user_email: str) -> None:
    assert _run(user_email).returncode == 0
    res = _run(user_email, "--revoke")
    assert res.returncode == 0, res.stderr
    meta = _app_meta(engine, user_email)
    assert "role" not in meta
    assert meta["provider"] == "google"


def test_何度実行しても同じ結果になる(engine: Engine, user_email: str) -> None:
    for _ in range(3):
        assert _run(user_email).returncode == 0
    assert _app_meta(engine, user_email) == {"provider": "google", "role": "admin"}


def test_居ない相手には失敗して理由を出す(engine: Engine) -> None:
    res = _run(f"absent-{uuid.uuid4().hex[:8]}@example.com")
    assert res.returncode == 1
    assert "アカウントがありません" in res.stderr
    # 「作れます」と誤解させないことまで含めて文言を固定する
    assert "アカウントを作りません" in res.stderr


def test_引数なしなら使い方を出して止まる() -> None:
    res = _run()
    assert res.returncode == 1
    assert "使い方" in res.stdout
