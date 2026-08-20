"""GAP-194 実 e2e: エラーが実際に「外へ送られる」ことを確認する。

やること:
  1. ローカルに Webhook 受信サーバーを立てる (Slack の代わり)
  2. 実 Postgres に本物のエラーを 1 件記録する (record_error)
  3. cron 本体 (run_error_alerts) を実行する
  4. 受信サーバーに本文が届いたことを確認する
  5. もう一度実行して「冷却中は送られない」ことを確認する

スタブは通知の宛先だけ。判定ロジック・DB 書き込み・HTTP 送信はすべて本物。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import uuid
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

RECEIVED: list[dict[str, str]] = []


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        RECEIVED.append(json.loads(body))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_args: object) -> None:
        pass


async def main() -> int:
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"[1] webhook 受信サーバー起動: http://127.0.0.1:{port}/hook")

    from src.observability.alerts import run_error_alerts
    from src.observability.notify import AlertSettings

    settings = AlertSettings(
        email_to="",
        slack_webhook_url=f"http://127.0.0.1:{port}/hook",
        cooldown_minutes=60,
        notify_warnings=False,
        max_per_run=5,
        dashboard_url="https://atelier.example/admin/s_t05",
    )

    engine = create_async_engine(PG, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    marker = f"e2e-194-{uuid.uuid4().hex[:8]}"
    failures: list[str] = []
    try:
        # record_error は service セッションを使うので、直接 SQL で同じことをする
        async with factory() as session:
            await session.execute(
                text(
                    "insert into public.error_log "
                    "(source, level, kind, message, path, fingerprint) "
                    "values ('api', 'error', 'ZeroDivisionError', :m, '/e2e', :fp)"
                ),
                {"m": f"division by zero {marker}", "fp": marker},
            )
            await session.commit()
            print(f"[2] 本物のエラーを 1 件記録: fingerprint={marker}")

            result = await run_error_alerts(session, settings=settings)
            print(f"[3] cron 実行: {result}")

            await asyncio.sleep(0.2)
            hit = [r for r in RECEIVED if marker in r.get("text", "")]
            if not hit:
                failures.append("Webhook に通知が届かなかった")
            else:
                print("[4] 実際に届いた本文:")
                for line in hit[0]["text"].splitlines():
                    print(f"      {line}")
                if "https://atelier.example/admin/s_t05" not in hit[0]["text"]:
                    failures.append("運営画面へのリンクが本文に無い")

            row = (
                await session.execute(
                    text(
                        "select last_status, notified_count, reported_errors "
                        "from public.error_alerts where fingerprint = :fp"
                    ),
                    {"fp": marker},
                )
            ).first()
            if row is None or row.last_status != "sent":
                failures.append(f"送信記録が sent になっていない: {row}")
            else:
                print(
                    f"[5] DB の送信記録: status={row.last_status} "
                    f"回数={row.notified_count} 伝えた件数={row.reported_errors}"
                )

            before = len(RECEIVED)
            await session.execute(
                text(
                    "insert into public.error_log "
                    "(source, level, kind, message, path, fingerprint) "
                    "values ('api', 'error', 'ZeroDivisionError', :m, '/e2e', :fp)"
                ),
                {"m": f"division by zero {marker}", "fp": marker},
            )
            await session.commit()
            await run_error_alerts(session, settings=settings)
            await asyncio.sleep(0.2)
            if len(RECEIVED) != before:
                failures.append("冷却中なのに再送された (メール爆撃になる)")
            else:
                print("[6] 冷却中の再発では再送されない (確認)")

            await session.execute(
                text("delete from public.error_log where fingerprint = :fp"), {"fp": marker}
            )
            await session.execute(
                text("delete from public.error_alerts where fingerprint = :fp"), {"fp": marker}
            )
            await session.commit()
    finally:
        await engine.dispose()
        server.shutdown()

    if failures:
        print("\nFAIL:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nPASS: 記録 → 判定 → 実 HTTP 送信 → 冷却 まで実データで確認")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
