"""cron 実行履歴 (GAP-013) — cron_run_history への記録と一覧。

記録は service 側 (Inngest handler wrapper) のみが行う。authenticated への
INSERT policy は無いので API 経由の改竄は不可。detail にはテナントデータを
入れない (件数・エラー種別などの運用メタのみ)。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.schemas.cron import CronRunResponse

logger = logging.getLogger(__name__)

_ERROR_MAX_LEN = 300


async def record_run(name: str, body: Callable[[], Awaitable[dict[str, str]]]) -> dict[str, str]:
    """cron 本体を実行しつつ running→success/error を cron_run_history に記録する。

    履歴記録の失敗は cron 本体の成否に影響させない (best-effort)。
    """
    factory: Any = None
    run_id: str | None = None
    try:
        from src.db import create_engine, create_session_factory

        factory = create_session_factory(create_engine())
        async with factory() as session:
            res = await session.execute(
                text(
                    "insert into public.cron_run_history (name, status) "
                    "values (:name, 'running') returning id"
                ),
                {"name": name},
            )
            run_id = str(res.scalar_one())
            await session.commit()
    except Exception:
        # 履歴が書けなくても cron 本体は止めない (best-effort)
        logger.exception("cron_run_history insert failed for %s", name)

    try:
        result = await body()
    except Exception as exc:
        await _finish(factory, run_id, status="error", detail={"error": str(exc)[:_ERROR_MAX_LEN]})
        raise
    await _finish(factory, run_id, status="success", detail=dict(result))
    return result


async def _finish(factory: Any, run_id: str | None, *, status: str, detail: dict[str, str]) -> None:
    if run_id is None:
        return
    try:
        async with factory() as session:
            await session.execute(
                text(
                    "update public.cron_run_history "
                    "set status = :st, finished_at = now(), detail = cast(:d as jsonb) "
                    "where id = cast(:id as uuid)"
                ),
                {"id": run_id, "st": status, "d": json.dumps(detail, ensure_ascii=False)},
            )
            await session.commit()
    except Exception:  # pragma: no cover
        logger.exception("cron_run_history finish failed for %s", run_id)


async def list_runs(
    session: AsyncSession, *, name: str | None = None, limit: int = 20
) -> list[CronRunResponse]:
    """実行履歴一覧 (新しい順)。RLS: platform 行 + 所属 project 行のみ可視。"""
    limit = max(1, min(limit, 100))
    where = ["1=1"]
    params: dict[str, object] = {"lim": limit}
    if name is not None:
        where.append("name = :name")
        params["name"] = name
    res = await session.execute(
        text(
            "select id, name, schedule_id, project_id, started_at, finished_at, "
            "status, detail from public.cron_run_history "
            f"where {' and '.join(where)} order by started_at desc limit :lim"
        ),
        params,
    )
    out: list[CronRunResponse] = []
    for row in res.all():
        raw_detail: object = row.detail
        detail: dict[str, object] = (
            json.loads(raw_detail) if isinstance(raw_detail, str) else (raw_detail or {})  # type: ignore[arg-type]
        )
        out.append(
            CronRunResponse(
                id=str(row.id),
                name=str(row.name),
                schedule_id=(None if row.schedule_id is None else str(row.schedule_id)),
                project_id=(None if row.project_id is None else str(row.project_id)),
                started_at=row.started_at,
                finished_at=row.finished_at,
                status=str(row.status),  # type: ignore[arg-type]
                detail=detail,
            )
        )
    return out
