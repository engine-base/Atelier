"""運営専用ルートの関所 (GAP-295 / GAP-296)。

- **本文の検証より先に** 403 を返す (通し F: owner が運営専用 POST/PATCH を叩くと
  422 が先に返り、スキーマの形が推測できていた)。FastAPI は依存関係を本文検証より
  先に解決するので、route の decorator `dependencies=[Depends(require_admin)]` に
  置けば本文を見る前に止まる。
- 拒否を監査ログ `admin.access_denied` に残す (通し J02-11 / J61-02 の期待)。
  監査は service 経路で best-effort (失敗しても 403 は返す)。
"""

from __future__ import annotations

import ipaddress
import logging
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

from src.audit import AuditEvent, AuditWriter
from src.db.session import shared_session_factory
from src.dependencies import CurrentUser, get_current_user
from src.services.admin import is_admin

logger = logging.getLogger(__name__)

ADMIN_DENIED_ACTION = "admin.access_denied"


def _client_ip(request: Request) -> str | None:
    """inet 列に入る形だけ渡す (TestClient の 'testclient' 等は None)。"""
    host = request.client.host if request.client else None
    if not host:
        return None
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return None
    return host


async def _record_denial(user: CurrentUser, request: Request) -> None:
    try:
        factory = shared_session_factory()
        async with factory() as session:
            await AuditWriter(session).write(
                AuditEvent(
                    action=ADMIN_DENIED_ACTION,
                    target_type="admin_route",
                    actor_type="user",
                    actor_id=user.id,
                    target_id=None,
                    ip_address=_client_ip(request),
                    after={"method": request.method, "path": request.url.path},
                )
            )
            await session.commit()
    except Exception:  # pragma: no cover - 監査の失敗で 403 を止めない
        logger.exception("admin denial audit failed")


async def require_admin(
    request: Request, user: Annotated[CurrentUser, Depends(get_current_user)]
) -> CurrentUser:
    if not is_admin(user):
        await _record_denial(user, request)
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")
    return user
