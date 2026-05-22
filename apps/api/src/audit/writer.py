"""AuditEvent / AuditWriter — audit_log table への INSERT 層。

audit_log table の schema は Group D で配置される (created_at, actor_id, action,
resource_type, resource_id, metadata JSONB, ip, user_agent, status_code, ...)。
本モジュールはその table への raw SQL INSERT を行う薄いラッパ。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

AUDIT_TABLE = "audit_log"


@dataclass(frozen=True)
class AuditEvent:
    """1 件の audit イベント。"""

    action: str
    """e.g. 'auth.signin', 'project.update', 'rls.bypass_attempt'"""

    actor_id: str | None = None
    """JWT sub claim。匿名 request の場合は None"""

    resource_type: str | None = None
    """e.g. 'project', 'task', 'memo'"""

    resource_id: str | None = None

    metadata: dict[str, object] = field(default_factory=lambda: dict[str, object]())
    """任意の構造化 metadata (JSONB に保存)"""

    ip: str | None = None
    user_agent: str | None = None
    status_code: int | None = None

    created_at: datetime = field(default_factory=lambda: datetime.now(tz=UTC))


class AuditWriter:
    """audit_log table への defensive な INSERT 層。

    INSERT が失敗しても例外を伝播せず logger.warning に流す。
    business request が audit の失敗で落ちないようにする (defense in depth)。
    """

    def __init__(self, session: AsyncSession, *, table: str = AUDIT_TABLE) -> None:
        self._session = session
        self._table = table

    async def write(self, event: AuditEvent) -> bool:
        """イベントを 1 件 INSERT する。成功で True、失敗で False。"""
        sql = text(
            f"INSERT INTO {self._table} "
            "(created_at, action, actor_id, resource_type, resource_id, "
            " metadata, ip, user_agent, status_code) "
            "VALUES (:created_at, :action, :actor_id, :resource_type, :resource_id, "
            "        CAST(:metadata AS JSONB), :ip, :user_agent, :status_code)"
        )
        params: dict[str, object | None] = {
            "created_at": event.created_at,
            "action": event.action,
            "actor_id": event.actor_id,
            "resource_type": event.resource_type,
            "resource_id": event.resource_id,
            "metadata": json.dumps(event.metadata, ensure_ascii=False),
            "ip": event.ip,
            "user_agent": event.user_agent,
            "status_code": event.status_code,
        }
        try:
            await self._session.execute(sql, params)
        except Exception as exc:
            # audit 失敗で業務 request を落とさない。warn に流す。
            logger.warning(
                "audit_log write failed: action=%s actor=%s error=%s",
                event.action,
                event.actor_id,
                exc,
            )
            return False
        return True
