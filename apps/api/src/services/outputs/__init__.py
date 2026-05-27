"""成果物 (workflow_outputs) サービス層 (T-A-21)。

RLS が効く AsyncSession を受け取り workflow_outputs を読む。可視性は RLS (T-D-21)。
成果物は工程生成で作られるため本層は read (一覧・取得) のみ。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.schemas.outputs import OutputResponse

_COLS = (
    "id, project_id, phase_id, stage, html_path, json_path, md_path, "
    "summary, version, created_at, updated_at, deleted_at"
)


def _row_to_response(row: Any) -> OutputResponse:
    return OutputResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        phase_id=(None if row.phase_id is None else str(row.phase_id)),
        stage=str(row.stage),
        html_path=(None if row.html_path is None else str(row.html_path)),
        json_path=(None if row.json_path is None else str(row.json_path)),
        md_path=(None if row.md_path is None else str(row.md_path)),
        summary=(None if row.summary is None else str(row.summary)),
        version=int(row.version),
        deleted_at=row.deleted_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_outputs(
    session: AsyncSession,
    *,
    project_id: str | None = None,
    phase_id: str | None = None,
    stage: str | None = None,
) -> list[OutputResponse]:
    where = ["deleted_at is null"]
    params: dict[str, object] = {}
    if project_id is not None:
        where.append("project_id = cast(:pid as uuid)")
        params["pid"] = project_id
    if phase_id is not None:
        where.append("phase_id = cast(:phid as uuid)")
        params["phid"] = phase_id
    if stage is not None:
        where.append("stage = cast(:st as workflow_stage_enum)")
        params["st"] = stage
    res = await session.execute(
        text(
            f"select {_COLS} from public.workflow_outputs "
            f"where {' and '.join(where)} order by created_at desc"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_output(session: AsyncSession, output_id: str) -> OutputResponse | None:
    res = await session.execute(
        text(
            f"select {_COLS} from public.workflow_outputs "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": output_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)
