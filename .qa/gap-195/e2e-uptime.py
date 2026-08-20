"""GAP-195 実 e2e: サーバーが落ちて・戻ったことが外から記録され、通知されるか。

やること (すべて実物):
  1. 本物の HTTP サーバーを立てる = 監視対象
  2. 本物の Webhook 受信サーバーを立てる = 通知先 (Slack の代わり)
  3. 実 Postgres に記録しながら、生きている → 落ちる → 落ちたまま → 復旧 を観測
  4. 通知が「落ちた時」と「復旧した時」だけ飛ぶこと (落ちたままでは飛ばない) を確認
  5. 停止していた時間が記録に残り、24h 稼働率として読めることを確認

スタブは 0。probe は実 HTTP、通知は実 HTTP POST、記録は実 Postgres。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import uuid
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "api"))
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "e2e")

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

PG = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)

HEALTHY = {"value": True}
RECEIVED: list[dict[str, str]] = []


class _Service(BaseHTTPRequestHandler):
    """監視対象。HEALTHY を False にすると 503 を返す = 落ちた状態。"""

    def do_GET(self) -> None:
        if HEALTHY["value"]:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b"service unavailable")

    def log_message(self, *_args: object) -> None:
        pass


class _Hook(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        RECEIVED.append(json.loads(self.rfile.read(length).decode("utf-8")))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_args: object) -> None:
        pass


async def main() -> int:
    service = HTTPServer(("127.0.0.1", 0), _Service)
    hook = HTTPServer(("127.0.0.1", 0), _Hook)
    threading.Thread(target=service.serve_forever, daemon=True).start()
    threading.Thread(target=hook.serve_forever, daemon=True).start()
    service_url = f"http://127.0.0.1:{service.server_address[1]}/health"
    hook_url = f"http://127.0.0.1:{hook.server_address[1]}/hook"
    print(f"[1] 監視対象: {service_url}")
    print(f"[2] 通知先 (Slack の代わり): {hook_url}")

    from src.observability.notify import AlertSettings
    from src.observability.uptime import Target, check_targets, summarize

    settings = AlertSettings(
        email_to="",
        slack_webhook_url=hook_url,
        cooldown_minutes=60,
        notify_warnings=False,
        max_per_run=5,
        dashboard_url="https://atelier.example/admin/s_t05",
    )
    name = f"e2e-195-{uuid.uuid4().hex[:8]}"
    target = Target(name, service_url)
    engine = create_async_engine(PG, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    failures: list[str] = []
    try:
        async with factory() as session:
            now = datetime.now(UTC)

            r = await check_targets(session, [target], now=now, settings=settings)
            print(f"[3] 稼働中を観測: {r}")
            if r["up"] != "1" or r["notified"] != "0":
                failures.append("稼働中の初回観測で通知が飛んだ (静かであるべき)")

            HEALTHY["value"] = False
            print("[4] 監視対象を落とした (503 を返す状態)")
            r = await check_targets(session, [target], now=now, settings=settings)
            await asyncio.sleep(0.2)
            print(f"    観測: {r}")
            if r["down"] != "1" or r["notified"] != "1":
                failures.append("落ちたのに通知されなかった")
            elif RECEIVED:
                print("[5] 実際に届いた通知:")
                for line in RECEIVED[-1]["text"].splitlines():
                    print(f"      {line}")
            else:
                failures.append("Webhook に通知が届かなかった")

            before = len(RECEIVED)
            r = await check_targets(session, [target], now=now, settings=settings)
            await asyncio.sleep(0.2)
            if len(RECEIVED) != before:
                failures.append("落ちたままなのに再通知された (15 分ごとに送ってしまう)")
            else:
                print("[6] 落ちたままでは再通知しない (確認)")

            HEALTHY["value"] = True
            r = await check_targets(session, [target], now=now, settings=settings)
            await asyncio.sleep(0.2)
            print(f"[7] 復旧を観測: {r}")
            if len(RECEIVED) != before + 1:
                failures.append("復旧の通知が飛ばなかった")
            else:
                print("    実際に届いた通知:")
                for line in RECEIVED[-1]["text"].splitlines():
                    print(f"      {line}")
                if "復旧" not in RECEIVED[-1]["text"]:
                    failures.append("復旧通知の本文に復旧と書かれていない")

            summary = next((s for s in await summarize(session) if s.target == name), None)
            if summary is None:
                failures.append("集計に出てこない")
            else:
                print(
                    f"[8] 集計: 状態={'応答あり' if summary.ok else '応答なし'} "
                    f"24h 稼働率={summary.availability_24h}% ({summary.checks_24h} 回)"
                )
                if summary.availability_24h != 50.0:
                    failures.append(
                        f"稼働率が実測と合わない (4 回中 2 回成功 = 50% のはず): "
                        f"{summary.availability_24h}"
                    )

            await session.execute(
                text("delete from public.uptime_checks where target = :t"), {"t": name}
            )
            await session.commit()
    finally:
        await engine.dispose()
        service.shutdown()
        hook.shutdown()

    if failures:
        print("\nFAIL:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nPASS: 稼働 → 停止 → 停止継続 → 復旧 を実 HTTP・実 DB・実通知で確認")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
