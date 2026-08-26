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

from fastapi import HTTPException, status
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


async def _record(exc: BaseException, scope: Scope) -> str | None:
    """未捕捉例外を自前のエラーログに残し、**参照 ID を返す** (best-effort)。

    返した ID は利用者に見せる文言に添える。利用者は原因を知る必要が無いが、
    問い合わせのときに「この ID」と言えれば運営が error_log の 1 行を特定できる。
    DB 自体が落ちている場合は記録に失敗するので None が返る — そのときは
    ID 無しの文言だけを出す (記録できないことを理由にレスポンスを壊さない)。
    """
    try:
        from src.observability.errors import record_exception

        raw_path: Any = scope.get("path", "")
        raw_method: Any = scope.get("method", "")
        return await record_exception(
            exc,
            source="api",
            path=str(raw_path) if raw_path else None,
            method=str(raw_method) if raw_method else None,
            status_code=500,
        )
    except Exception:  # pragma: no cover - 記録失敗でレスポンスを壊さない
        traceback.print_exc()
        return None


#: 未捕捉例外のときに利用者へ返す文言。
#:
#: **例外クラス名とリクエストパスを本文に載せない。** 以前は
#: `internal server error (ConnectionRefusedError) at /auth/signin` を
#: そのまま返しており、画面はこれを赤帯に出していた。2 つの問題がある:
#:
#:   1. 利用者に内部の実装 (例外クラス名・内部パス) が漏れる。
#:   2. 読んだ人が次に何をすればいいか分からない。GAP-206 で 503 の理由を
#:      利用者の言葉に翻訳したのに、500 だけが英語の内部語のまま残っていた。
#:
#: 原因の特定は traceback (サーバーログ) と error_log が担う。利用者には
#: 「時間をおいて試す」「困ったら参照 ID を伝える」だけを渡す。
UNHANDLED_MESSAGE = "サーバー側で問題が発生しました。時間をおいて、もう一度お試しください。"


def unhandled_detail(ref: str | None) -> str:
    """利用者に見せる 500 の本文を作る (参照 ID は取れたときだけ添える)。"""
    return f"{UNHANDLED_MESSAGE}（参照 ID: {ref}）" if ref else UNHANDLED_MESSAGE


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
            # GAP-182: 本番で落ちたことに誰も気づけない状態をやめる。
            # 外部 SaaS には送らず自前の error_log に記録する (失敗しても無視)。
            ref = await _record(exc, scope)
            if response_started:
                # 応答送信途中の失敗は差し替え不能 — そのまま伝播させる
                raise
            response = JSONResponse(
                status_code=500,
                content={"detail": unhandled_detail(ref)},
            )
            await response(scope, receive, send)


# --------------------------------------------------------------------------- #
# GAP-206: 503 の「理由」を機械可読で返す。
#
# **これまでの実態**: 503 は 30 か所以上で使われていて、原因は
# 「本人の PC (Bridge) が未接続」「保存先 (storage) が未設定」「LLM 経路が
# 未設定」と別物なのに、画面には **同じ 503 としてしか届いていなかった**。
# その結果、画面は status だけで原因を推測し、
#   - 保存先の設定漏れなのに「パソコンを繋いでください」と案内する
#   - あるいは「未接続、または保存先が未設定」と両論併記で逃げる
# という状態だった。**どちらも利用者は次に何をすればいいか分からない。**
#
# service 層は既に `exc.code` で原因を区別しているので、それを**そのまま
# ヘッダで返す**。本文の形は変えないので既存の呼び出しは壊れない。
# --------------------------------------------------------------------------- #

#: 原因を載せるヘッダ名 (CORS の expose_headers にも入れること)。
REASON_HEADER = "X-Atelier-Reason"


def service_unavailable(reason: str, message: str) -> HTTPException:
    """503 を **理由つきで** 返す。

    `reason` は service 層の `exc.code` をそのまま渡す
    (`bridge_offline` / `storage_unconfigured` / `llm_unconfigured` 等)。
    画面はこれを見て案内を変える — 推測させない。
    """
    return HTTPException(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        message,
        headers={REASON_HEADER: reason},
    )
