"""GAP-240 回帰: Bridge presence は本人スコープで判定する (実 PG)。

以前 `worker_online` は全利用者横断だったため、他人の Bridge がオンラインなら
未接続の利用者のジョブまで enqueue され、誰にも拾われず無応答になっていた。
本テストは「A の Bridge がオンラインでも、B (未接続) は offline と判定される」こと、
および「未接続 (トークン未発行) と未起動 (トークンあり) を区別できる」ことを
実 DB で固定する。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from src.services import chat_relay
from tests.routes.test_auth import (
    PG_ASYNC,
    PG_SYNC,
    app,
    auth_user,
    created_emails,
    sync_engine,
)

# pytest は名前で fixture を解決する — import した fixture を「使用済み」にする
__all__ = ["app", "auth_user", "created_emails", "sync_engine"]


def _db_available() -> bool:
    try:
        eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
        try:
            with eng.connect() as c:
                c.execute(text("select 1"))
        finally:
            eng.dispose()
        return True
    except Exception:
        return False


pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not _db_available(), reason="local Postgres not available"),
    pytest.mark.filterwarnings("ignore::ResourceWarning"),
    pytest.mark.filterwarnings("ignore::pytest.PytestUnraisableExceptionWarning"),
]


def _quiesce_other_workers(sync_engine: sqlalchemy.Engine) -> None:
    """同じ DB を使う他のテストが残した presence (インスタンス worker 等) を鮮度切れにする。

    presence は「鮮度 90 秒内の行があるか」で判定するので、直前の route テストが
    ping した worker が残っていると本テストの判定が汚染される。
    """
    with sync_engine.begin() as c:
        c.execute(text("update public.bridge_workers set last_seen_at = now() - interval '1 hour'"))


def _run[T](fn: Callable[[AsyncSession], Awaitable[T]]) -> T:
    async def _go() -> T:
        engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
        try:
            factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
            async with factory() as session:
                return await fn(session)
        finally:
            await engine.dispose()

    return asyncio.run(_go())


def test_presence_is_scoped_to_the_requesting_user(
    sync_engine: sqlalchemy.Engine, auth_user: dict[str, str]
) -> None:
    user_a = auth_user["user_id"]
    user_b = str(uuid.uuid4())  # 未接続の別利用者 (worker も token も無い)
    worker_id = f"qa-presence-{uuid.uuid4()}"
    _quiesce_other_workers(sync_engine)
    with sync_engine.begin() as c:
        c.execute(
            text(
                "insert into public.bridge_workers (id, host_label, version, user_id, last_seen_at) "
                "values (:i, 'qa-host', '0.1.0', cast(:u as uuid), now())"
            ),
            {"i": worker_id, "u": user_a},
        )
    try:
        assert _run(lambda s: chat_relay.worker_online(s, user_id=user_a)) is True
        # 他人 (A) の Bridge がオンラインでも、B は offline と判定される
        assert _run(lambda s: chat_relay.worker_online(s, user_id=user_b)) is False
        # 省略時は従来どおり全体 (インスタンス worker 用)
        assert _run(lambda s: chat_relay.worker_online(s)) is True
        # インスタンス worker (user_id null = 運営/セルフホストの共有 Bridge) は
        # 誰のジョブでも拾うので、未接続の B から見てもオンライン
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "insert into public.bridge_workers (id, host_label, version, last_seen_at) "
                    "values (:i, 'qa-instance', '0.1.0', now())"
                ),
                {"i": f"{worker_id}-instance"},
            )
        assert _run(lambda s: chat_relay.worker_online(s, user_id=user_b)) is True
    finally:
        with sync_engine.begin() as c:
            c.execute(
                text("delete from public.bridge_workers where id in (:i, :j)"),
                {"i": worker_id, "j": f"{worker_id}-instance"},
            )


def test_not_connected_vs_offline_are_distinguishable(
    sync_engine: sqlalchemy.Engine, auth_user: dict[str, str]
) -> None:
    user_a = auth_user["user_id"]
    _quiesce_other_workers(sync_engine)
    # トークン未発行 = 未接続
    assert _run(lambda s: chat_relay.user_has_bridge_token(s, user_id=user_a)) is False
    with sync_engine.begin() as c:
        c.execute(
            text(
                "insert into public.bridge_user_tokens (user_id, token_hash, label) "
                "values (cast(:u as uuid), :h, 'qa')"
            ),
            {"u": user_a, "h": f"qa-hash-{uuid.uuid4()}"},
        )
    # トークンあり (でも presence 無し) = 接続済みだが未起動
    assert _run(lambda s: chat_relay.user_has_bridge_token(s, user_id=user_a)) is True
    assert _run(lambda s: chat_relay.worker_online(s, user_id=user_a)) is False
