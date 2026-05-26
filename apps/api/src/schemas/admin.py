"""Admin API スキーマ (T-A-43)。

07_api_design/openapi.yaml#components/schemas/AuditLog (E-020 audit_logs)。
運営 admin が監査ログを閲覧する。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class AuditLogResponse(BaseModel):
    id: str
    workspace_id: str | None
    actor_type: str
    actor_id: str
    action: str
    target_type: str
    target_id: str | None
    before: dict[str, object] | None
    after: dict[str, object] | None
    ip_address: str | None
    created_at: datetime
