"""レスポンス送信前コミット (read-your-own-write 整合) ミドルウェア。

get_rls_session の commit は yield 依存の teardown で走るが、FastAPI の teardown は
レスポンス送信「後」に実行されるため、2xx を受け取った client が直後に送る次の
リクエストが未コミット行を読めない race が存在した (S-H01 design-audit で
POST /mocks → 201 直後の POST /mocks/{id}/versions が間欠 404 になる事象として検出)。

本 middleware は `http.response.start` を下流へ転送する「前」に当該リクエストの
RLS セッションを commit し、応答が client に見えた時点で書込が durable である
ことを保証する。

除外 (従来どおり teardown 側に委ねる):
  - SSE (text/event-stream): ストリーム本体が session を使い続けるため、
    ここで commit すると transaction-local な role/claims が失効し RLS が外れる。
  - status >= 400: 例外ハンドラ経由の応答。teardown の rollback に委ねる
    (ここで commit すると 4xx/5xx でも書込が残ってしまう)。

teardown 側の commit は本 middleware の commit 後は空トランザクションで無害。
"""

from __future__ import annotations

from contextvars import ContextVar
from typing import TYPE_CHECKING, cast

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession
    from starlette.types import ASGIApp, Message, Receive, Scope, Send

# get_rls_session が現リクエストのセッションを登録する (リクエスト task 内で共有)。
current_rls_session: ContextVar[AsyncSession | None] = ContextVar(
    "current_rls_session", default=None
)


def _content_type_of(message: Message) -> bytes:
    headers = cast("list[tuple[bytes, bytes]]", message.get("headers") or [])
    for key, value in headers:
        if key.lower() == b"content-type":
            return value
    return b""


class CommitBeforeResponseMiddleware:
    """http.response.start 転送前に現リクエストの RLS セッションを commit する。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                session = current_rls_session.get()
                if (
                    session is not None
                    and int(message["status"]) < 400
                    and not _content_type_of(message).startswith(b"text/event-stream")
                ):
                    await session.commit()
            await send(message)

        await self.app(scope, receive, send_wrapper)
