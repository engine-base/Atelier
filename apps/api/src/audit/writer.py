"""AuditEvent / AuditWriter — audit_logs table への INSERT 層。

audit_logs table の schema は 04_functional_breakdown/entities.json#E-020 が
信頼源 (T-D-11 で live DB に配置済):
  (id, workspace_id, actor_type, actor_id, action, target_type, target_id,
   before, after, ip_address, created_at)

本モジュールはその table への raw SQL INSERT を行う薄いラッパ。
audit_logs は append-only (UPDATE/DELETE はアプリ層で禁止)。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

AUDIT_TABLE = "audit_logs"

ActorType = Literal["ai", "user", "system", "anonymous"]


@dataclass(frozen=True)
class AuditEvent:
    """1 件の audit イベント (E-020 AuditLog 準拠)。"""

    action: str
    """e.g. 'auth.signin', 'project.update', 'rls.bypass_attempt'
    (dot-separated lower snake、^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$ format)"""

    target_type: str
    """e.g. 'project', 'task', 'memo' (entities.json target_type)"""

    actor_type: ActorType = "system"
    """ai / user / system / anonymous"""

    actor_id: str = "system"
    """actor_type=user なら users.id (UUID string)、ai なら ai_employees.id、
    system なら 'system'、anonymous なら 'anonymous'"""

    workspace_id: str | None = None
    """workspace_scoped event の場合の workspace UUID。
    system / pre-auth event では None (table 側で NULL 許容)"""

    target_id: str | None = None
    """対象 entity の UUID。集計 event 等で None も許容"""

    before: dict[str, object] | None = None
    """変更前の state (JSONB)。create event では None"""

    after: dict[str, object] | None = None
    """変更後の state (JSONB)。delete event では None"""

    ip_address: str | None = None
    """発信元 IP (inet 型に CAST される)"""

    created_at: datetime = field(default_factory=lambda: datetime.now(tz=UTC))


class AuditWriter:
    """audit_logs table への defensive な INSERT 層。

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
            "(created_at, workspace_id, actor_type, actor_id, action, "
            " target_type, target_id, before, after, ip_address) "
            "VALUES (:created_at, :workspace_id, :actor_type, :actor_id, :action, "
            "        :target_type, :target_id, "
            "        CAST(:before AS JSONB), CAST(:after AS JSONB), "
            "        CAST(:ip_address AS INET))"
        )
        params: dict[str, object | None] = {
            "created_at": event.created_at,
            "workspace_id": event.workspace_id,
            "actor_type": event.actor_type,
            "actor_id": event.actor_id,
            "action": event.action,
            "target_type": event.target_type,
            "target_id": event.target_id,
            "before": (
                json.dumps(event.before, ensure_ascii=False) if event.before is not None else None
            ),
            "after": (
                json.dumps(event.after, ensure_ascii=False) if event.after is not None else None
            ),
            "ip_address": event.ip_address,
        }
        try:
            await self._session.execute(sql, params)
        except Exception as exc:
            # audit 失敗で業務 request を落とさない。warn に流す。
            logger.warning(
                "audit_logs write failed: action=%s actor=%s/%s error=%s",
                event.action,
                event.actor_type,
                event.actor_id,
                exc,
            )
            return False
        return True
