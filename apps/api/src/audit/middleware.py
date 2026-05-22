"""FastAPI ASGI middleware — HTTP request を audit_log に自動記録。

呼び出し側で AsyncSession factory を inject する。
exempt path (e.g. /health, /metrics) は記録しない。
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Iterable
from contextlib import AbstractAsyncContextManager

from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from .writer import AuditEvent, AuditWriter

logger = logging.getLogger(__name__)

# 監視 / liveness / readiness は audit 対象外
DEFAULT_EXEMPT_PATHS: frozenset[str] = frozenset(
    {"/health", "/healthz", "/ready", "/readyz", "/live", "/livez", "/metrics"}
)

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]
"""呼び出し時に AsyncSession context manager を返す factory。"""


class AuditMiddleware(BaseHTTPMiddleware):
    """HTTP request 毎に AuditEvent を 1 件 audit_log へ書く。"""

    def __init__(
        self,
        app: ASGIApp,
        *,
        session_factory: SessionFactory,
        exempt_paths: Iterable[str] | None = None,
        actor_extractor: Callable[[Request], str | None] | None = None,
    ) -> None:
        super().__init__(app)
        self._session_factory = session_factory
        self._exempt: frozenset[str] = frozenset(
            exempt_paths if exempt_paths is not None else DEFAULT_EXEMPT_PATHS
        )
        self._actor_extractor = actor_extractor or _default_actor_extractor

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        path = request.url.path
        if path in self._exempt:
            return await call_next(request)

        response = await call_next(request)

        # response 後に event を構築 (失敗しても response はそのまま返す)
        try:
            event = AuditEvent(
                action=f"{request.method.lower()}.{path}",
                actor_id=self._actor_extractor(request),
                ip=_client_ip(request),
                user_agent=request.headers.get("user-agent"),
                status_code=response.status_code,
                metadata={
                    "method": request.method,
                    "path": path,
                    "query": str(request.url.query) or None,
                },
            )
            async with self._session_factory() as session:
                writer = AuditWriter(session)
                await writer.write(event)
        except Exception as exc:  # defensive
            logger.warning("audit middleware swallowed exception: %s", exc)

        return response


def _default_actor_extractor(request: Request) -> str | None:
    """JWT claim から actor_id を抽出する default 実装。

    実プロダクトでは Authorization header の JWT を decode して sub claim を返す。
    本タスクでは starlette の state から取得 (auth middleware が先に走り state.user_id を set)。
    """
    user_id: object | None = getattr(request.state, "user_id", None)
    return user_id if isinstance(user_id, str) else None


def _client_ip(request: Request) -> str | None:
    """Cloudflare / Vercel proxy 経由でも実 client IP を取得する。"""
    forwarded = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client:
        return request.client.host
    return None
