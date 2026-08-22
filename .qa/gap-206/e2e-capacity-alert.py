"""GAP-206 実 e2e: 混雑が起きたことに **運営が気づける** ことを、本物の経路で確かめる。

これまでの実態:
  GAP-203 で「断らずに並ばせる」ようにしたが、**並んだこと自体は運営画面を
  見に行かないと分からなかった**。しかも順番待ちの数は machine ごとの
  プロセス内カウンタで、cron は 1 台でしか動かないため「もう 1 台で起きた
  混雑」には構造的に気づけない。

ここで通すもの (フェイクを挟まない):
  1. **本物のアプリ起動 (lifespan)** で記録先が差し込まれること
     — 単体テストは main.py の文字列を見ているだけなので、実際に起動して確かめる
  2. **本物の guarded_stream** で溢れさせ、DB に 1 行残ること
  3. **machine をまたいで**集計されること
  4. 送信先が無いときに **送ったふりをしない** こと
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import AsyncIterator
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "e2e-secret")
os.environ.setdefault(
    "ATELIER_DB_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
# 上限 2 本 (MIN_CONCURRENT) — 3 人目が並ぶ
os.environ["ATELIER_SSE_MAX_CONCURRENT"] = "2"
os.environ["FLY_MACHINE_ID"] = "e2e-machine-1"

from sqlalchemy import text  # noqa: E402

from main import app  # noqa: E402
from src.db import shared_session_factory  # noqa: E402
from src.observability import capacity_alerts as ca  # noqa: E402
from src.observability.notify import AlertSettings  # noqa: E402
from src.routes.chat_sse import guarded_stream  # noqa: E402
from src.services.chat_sse import capacity  # noqa: E402

failures: list[str] = []


def check(ok: bool, label: str) -> None:
    print(f"  {'OK  ' if ok else 'NG  '} {label}")
    if not ok:
        failures.append(label)


async def body(hold: asyncio.Event) -> AsyncIterator[bytes]:
    yield b'data: {"type": "start"}\n\n'
    await hold.wait()
    yield b'data: {"type": "end"}\n\n'


async def main() -> int:
    factory = shared_session_factory()
    async with factory() as s:  # 前回の残骸を消す
        await s.execute(text("delete from public.capacity_events"))
        await s.execute(text("delete from public.capacity_alert_state"))
        await s.commit()

    print("[1] **本物のアプリ起動**で記録先が差し込まれる")
    capacity.set_event_recorder(None)
    check(capacity._recorder is None, "起動前は記録先が無い")
    async with app.router.lifespan_context(app):
        check(capacity._recorder is not None, "起動後は記録先が差し込まれている")

        print()
        print("[2] **本物の SSE 経路**で溢れさせる → DB に 1 行残る")
        capacity.reset_for_tests()
        holds = [asyncio.Event(), asyncio.Event()]
        streams = [guarded_stream(body(h)).body_iterator for h in holds]  # type: ignore[attr-defined]
        for st in streams:
            await anext(st)
        check(capacity.snapshot().open_streams == 2, "上限 2 本まで埋まった")

        third = guarded_stream(body(asyncio.Event())).body_iterator  # type: ignore[attr-defined]
        event = await anext(third)
        check(b'"queued"' in event, f"3 人目は断られず並んだ (実際 {event[:40]!r})")
        # 記録はその場で書かれる (上限 2 秒。DB が遅くても利用者を待たせない)

        async with factory() as s:
            rows = (
                await s.execute(
                    text(
                        "select kind, machine_id, open_streams, stream_limit, queued, detail"
                        " from public.capacity_events order by occurred_at"
                    )
                )
            ).all()
        check(len(rows) == 1, f"混雑が 1 行残った (実際 {len(rows)} 行)")
        if rows:
            r = rows[0]
            print(
                f"     残った行: kind={r.kind} machine={r.machine_id} "
                f"open={r.open_streams}/{r.stream_limit} queued={r.queued} detail={r.detail}"
            )
            check(r.kind == "queued", "「並ばせた」として残っている (断ったとは書かない)")
            check(r.machine_id == "e2e-machine-1", "**どの machine で起きたか**が残っている")
            check(r.open_streams == 2 and r.stream_limit == 2, "そのときの混み具合も残っている")

        # 後片付け (席を返す)
        for h in holds:
            h.set()
        for st in streams:
            await st.aclose()
        await third.aclose()

    print()
    print("[3] **machine をまたいで**集計される (1 台からしか見えない、を無くす)")
    async with factory() as s:
        await s.execute(
            text(
                "insert into public.capacity_events"
                " (kind, machine_id, open_streams, stream_limit, queued, queue_limit)"
                " values ('queued', 'e2e-machine-2', 2, 2, 7, 4)"
            )
        )
        await s.commit()
        found = await ca.find_capacity_candidates(s)
    check(len(found) == 1, f"知らせる候補は 1 件 (実際 {len(found)})")
    if found:
        c = found[0]
        print(
            f"     集計: kind={c.kind} events={c.events} machines={c.machines} "
            f"peak_queued={c.peak_queued}"
        )
        check(c.machines == 2, "**2 台ぶんまとめて**数えている")
        check(c.peak_queued == 7, "一番混んだ時の人数が出る")
        title, lines = ca.build_capacity_message(c)
        print(f"     件名: {title}")
        for line in lines[:6]:
            print(f"       {line}")
        check("断ってはいません" in "\n".join(lines), "誰も断っていないことを明記する")

    print()
    print("[4] 送信先が無いときに **送ったふりをしない**")
    async with factory() as s:
        result = await ca.run_capacity_alerts(
            s,
            settings=AlertSettings(email_to="", slack_webhook_url=""),  # type: ignore[call-arg]
        )
        state = (
            await s.execute(
                text("select kind, last_notified_at, last_status from public.capacity_alert_state")
            )
        ).all()
    print(f"     結果: {result}")
    check(result.get("skipped") == "1" and result.get("sent") == "0", "送っていないと申告する")
    check(len(state) == 1 and state[0].last_status == "skipped", "skipped として残る")
    check(state[0].last_notified_at is None, "送っていないのに時刻を進めない (次回また試す)")

    async with factory() as s:  # 後片付け
        await s.execute(text("delete from public.capacity_events"))
        await s.execute(text("delete from public.capacity_alert_state"))
        await s.commit()

    print()
    if failures:
        print(f"FAIL: {len(failures)} 件")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(
        "PASS: 起動で記録先が差さり、実際の混雑が machine をまたいで集まり、"
        "送れないときは送ったふりをしない"
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
