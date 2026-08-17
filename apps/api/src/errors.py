"""未捕捉例外 → CORS ヘッダ付き JSON 500 変換 (2026-08-17 恒久対策)。

Starlette の既定では、未捕捉例外は最外殻の ServerErrorMiddleware が素の 500 を
返すため CORS ヘッダが付かない。ブラウザ側では実体がサーバー例外なのに
「CORS policy でブロック」と表示され、真因を 2 度誤診させた
(/knowledge・/chat/connection-status — いずれも migration 未適用の SQL エラー)。

本ミドルウェアは CORSMiddleware より内側 (app 寄り) に配置し、例外をここで
JSONResponse(500) に変換する — 応答は CORSMiddleware を通って出ていくため
CORS ヘッダが付き、ブラウザに正直な 500 が見える。traceback はサーバーログへ。
"""

from __future__ import annotations

import traceback
from typing import Any

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class UnhandledErrorMiddleware:
    """未捕捉例外を JSON 500 に変換する ASGI ミドルウェア。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        response_started = False

        async def send_wrapper(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:  # 最後の受け皿 (再送出すると素の 500 に戻る)
            traceback.print_exc()
            if response_started:
                # 応答送信途中の失敗は差し替え不能 — そのまま伝播させる
                raise
            path: Any = scope.get("path", "?")
            response = JSONResponse(
                status_code=500,
                content={"detail": f"internal server error ({type(exc).__name__}) at {path}"},
            )
            await response(scope, receive, send)
