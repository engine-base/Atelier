"""GAP-197 実 e2e: DB 接続プールの実測 (before / after)。

やること:
  1. **旧方式の再現** — 各サービスが個別に create_engine() していた頃と同じことをし、
     プロセス内の engine 数と「要求しうる最大接続数」を数える
  2. **現方式の実測** — 実際の service factory を全部呼び、engine が 1 個であることを確認
  3. **実接続での挙動** — 実 Postgres へ同時にセッションを開き、
     プールの使用中カウントが本当に動くことを確認
  4. **枯渇時の挙動** — 上限を超えた要求が「黙って遅くなる」のではなく
     明示的なエラーで返ることを確認 (待ち時間は pool_timeout)

推測なし。全部その場で測る。
"""

from __future__ import annotations

import asyncio
import gc
import importlib
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "api"))
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "e2e")
os.environ.setdefault(
    "ATELIER_DB_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

# 実際に service セッションを使っている場所 (tests/test_db_pool.py と同じ一覧)
SERVICE_FACTORIES = [
    ("src.dependencies", "_session_factory"),
    ("src.services.project_credentials", "_service_session_factory"),
    ("src.services.skills", "_service_session_factory"),
    ("src.services.admin.ops", "service_session_factory"),
    ("src.services.auth", "_service_session_factory"),
    ("src.services.client_signin", "_service_session_factory"),
    ("src.services.billing", "service_session_factory"),
    ("src.services.support", "_service_session_factory"),
    ("src.services.mocks.artifacts", "service_session_factory"),
    ("src.services.chat_sse.relay", "service_session_factory"),
    ("src.services.chat_sse.pc_artifacts", "_service_session_factory"),
    ("src.routes.admin_knowledge", "_service_session_factory"),
    ("src.routes.admin_design_templates", "_service_session_factory"),
]


async def main() -> int:
    from src.db.session import (
        DatabaseSettings,
        create_engine,
        describe_pool_budget,
        pool_stats,
        shared_engine,
        shared_session_factory,
    )

    failures: list[str] = []

    # ---------------------------------------------------------------- #
    print("[1] 旧方式の再現 (各サービスが個別に engine を作っていた頃)")
    old_cfg = DatabaseSettings(url=os.environ["ATELIER_DB_URL"], pool_size=10, max_overflow=5)
    old_engines = [create_engine(old_cfg) for _ in SERVICE_FACTORIES]
    old_capacity = sum(e.pool.size() + 5 for e in old_engines)
    print(f"    engine 数: {len(old_engines)}")
    print(f"    要求しうる最大接続数: {old_capacity} / machine")
    print(f"    fly.toml の max_machines_running=2 なら: {old_capacity * 2}")
    for e in old_engines:
        await e.dispose()
    old_engines.clear()  # 数え直しに混ざらないよう参照を落とす
    del e
    gc.collect()

    # ---------------------------------------------------------------- #
    print("\n[2] 現方式の実測 (service factory を全部呼ぶ)")
    binds: set[int] = set()
    for module_name, attr in SERVICE_FACTORIES:
        factory = getattr(importlib.import_module(module_name), attr)()
        binds.add(id(factory.kw["bind"]))
    gc.collect()
    alive = [o for o in gc.get_objects() if isinstance(o, AsyncEngine)]
    print(f"    service factory が使っている engine の種類数: {len(binds)}")
    print(f"    プロセス内に生きている AsyncEngine 数: {len(alive)}")
    budget_text, budget_ok = describe_pool_budget()
    print(f"    {budget_text}")
    if len(binds) != 1:
        failures.append(f"engine が {len(binds)} 個ある (1 個であるべき)")
    if not budget_ok:
        failures.append("既定設定が接続予算を超えている")

    # ---------------------------------------------------------------- #
    print("\n[3] 実接続での挙動 (実 Postgres に同時オープン)")
    factory = shared_session_factory()
    idle = pool_stats().checked_out
    opened = []
    try:
        for _ in range(5):
            session = factory()
            await session.__aenter__()
            await session.execute(text("select 1"))
            opened.append(session)
        busy = pool_stats()
        print(
            f"    同時 5 セッション: 使用中 {busy.checked_out} "
            f"(待機中 {busy.checked_in} / 1 台あたり上限 {busy.capacity})"
        )
        if busy.checked_out != idle + 5:
            failures.append(f"使用中カウントが実態と合わない: {busy.checked_out} (期待 {idle + 5})")
    finally:
        for session in opened:
            await session.__aexit__(None, None, None)
    after = pool_stats().checked_out
    print(f"    解放後: 使用中 {after}")
    if after != idle:
        failures.append("解放後に使用中カウントが戻っていない")

    # ---------------------------------------------------------------- #
    print("\n[4] 枯渇時の挙動 (黙って遅くならず、明示的に失敗するか)")
    tiny = create_engine(
        DatabaseSettings(
            url=os.environ["ATELIER_DB_URL"], pool_size=1, max_overflow=0, pool_timeout=1.0
        )
    )
    from sqlalchemy.ext.asyncio import async_sessionmaker

    tiny_factory = async_sessionmaker(bind=tiny, expire_on_commit=False)
    held = tiny_factory()
    await held.__aenter__()
    await held.execute(text("select 1"))
    started = time.monotonic()
    try:
        extra = tiny_factory()
        await extra.__aenter__()
        await extra.execute(text("select 1"))
        failures.append("上限を超えても取れてしまった (上限が効いていない)")
        await extra.__aexit__(None, None, None)
    except Exception as exc:
        waited = time.monotonic() - started
        print(f"    上限超過は {waited:.1f} 秒で {type(exc).__name__} として返った")
        print(f"    → 無限に待たず、原因の分かる失敗になる ({str(exc)[:80]})")
        if waited > 3.0:
            failures.append(f"待ち時間が長すぎる: {waited:.1f}s")
    finally:
        await held.__aexit__(None, None, None)
        await tiny.dispose()

    await shared_engine().dispose()

    if failures:
        print("\nFAIL:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(
        f"\nPASS: {len(SERVICE_FACTORIES)} engine ({old_capacity} 接続/machine) → "
        f"1 engine ({pool_stats().capacity} 接続/machine) を実測で確認"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
