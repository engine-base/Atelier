"""GAP-201 実 e2e: 「待っている間は DB 接続を手放す」ことの実測。

やること (すべて実物):
  1. 実 Postgres に RLS セッションを開き、GAP-201 の貼り直しフックを入れる
  2. SSE と同じ順序で「文脈構築 → commit → 長い待ち → 保存」を再現し、
     **待っている間 DB 接続が 0 本**であることを測る
  3. commit のあとも **RLS (role / claims) が効いたまま**であることを確認
     (ここが崩れると、途中で commit した後の SQL が RLS 無しで走ってしまう)
  4. 同時 100 本の「待ち」を作って、接続が増えないことを測る
  5. 開いている SSE 1 本あたりの実メモリを測り、上限の根拠にする
"""

from __future__ import annotations

import asyncio
import json
import os
import resource
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "api"))
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "e2e")
os.environ.setdefault(
    "ATELIER_DB_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)

from sqlalchemy import text

from src.db.session import (
    DatabaseSettings,
    create_engine,
    create_session_factory,
    pool_stats,
)
from src.dependencies import _install_rls_guard

failures: list[str] = []


def check(ok: bool, label: str) -> None:
    print(f"  {'OK  ' if ok else 'NG  '} {label}")
    if not ok:
        failures.append(label)


def rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


async def main() -> int:
    engine = create_engine(DatabaseSettings(url=os.environ["ATELIER_DB_URL"]))
    factory = create_session_factory(engine)
    claims = json.dumps({"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"})

    print("[1] SSE と同じ順序を再現する（文脈構築 → commit → 待ち → 保存）")
    async with factory() as session:
        _install_rls_guard(session, claims)

        # --- 文脈構築フェーズ（実際は履歴・ペルソナ・RAG などを読む）---
        await session.execute(text("select 1"))
        during_build = pool_stats(engine).checked_out
        applied = (
            await session.execute(text("select current_setting('request.jwt.claims', true)"))
        ).scalar()
        role = (await session.execute(text("select current_user"))).scalar()
        print(f"    文脈構築中: 接続 {during_build} 本 / role={role}")
        check(during_build == 1, "文脈構築の間は接続を 1 本使う（当然）")
        check(applied == claims, "RLS の claims が入っている")
        check(str(role) == "authenticated", "role が authenticated に下がっている")

        # --- ここで確定して手放す ---
        await session.commit()
        idle = pool_stats(engine).checked_out
        print(f"    commit 直後: 接続 {idle} 本")
        check(idle == 0, "**待っている間は接続を 0 本しか使わない**")

        # --- 本人の PC の実行待ち（実際は数分）---
        await asyncio.sleep(0.3)
        check(pool_stats(engine).checked_out == 0, "待っている間ずっと 0 本のまま")

        # --- 保存フェーズ（assistant 発言・監査ログ）---
        applied2 = (
            await session.execute(text("select current_setting('request.jwt.claims', true)"))
        ).scalar()
        role2 = (await session.execute(text("select current_user"))).scalar()
        after = pool_stats(engine).checked_out
        print(f"    保存フェーズ: 接続 {after} 本 / role={role2}")
        check(after == 1, "保存のときだけ取り直す")
        check(applied2 == claims, "commit のあとも RLS の claims が効いている")
        check(str(role2) == "authenticated", "commit のあとも role が authenticated のまま")
        await session.commit()

    print("\n[2] 同時 100 本の「待ち」で接続が増えないこと")
    base_rss = rss_mb()
    sessions = []
    for _ in range(100):
        s = factory()
        await s.__aenter__()
        _install_rls_guard(s, claims)
        await s.execute(text("select 1"))
        await s.commit()  # 文脈構築が終わって待ちに入った状態
        sessions.append(s)
    holding = pool_stats(engine).checked_out
    rss_delta = rss_mb() - base_rss
    print(f"    100 本が待機中: 接続 {holding} 本 / メモリ増 {rss_delta:.1f} MB")
    check(holding == 0, "100 本待たせても DB 接続は 0 本")
    for s in sessions:
        await s.__aexit__(None, None, None)

    print("\n[3] 比べる: 以前の方式（commit しないで待つ）")
    old_sessions = []
    for _ in range(10):
        s = factory()
        await s.__aenter__()
        _install_rls_guard(s, claims)
        await s.execute(text("select 1"))  # commit しない = 掴んだまま
        old_sessions.append(s)
    old_holding = pool_stats(engine).checked_out
    print(f"    10 本が待機中: 接続 {old_holding} 本 ← 人数ぶん食い潰す")
    check(old_holding == 10, "以前は待っている人数ぶん接続を握っていた（再現）")
    for s in old_sessions:
        await s.__aexit__(None, None, None)

    await engine.dispose()

    if failures:
        print("\nFAIL:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nPASS: 待機中の接続 0 本 / commit 後も RLS 継続 / 100 人待たせても 0 本 を実測")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
