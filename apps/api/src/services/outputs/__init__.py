"""成果物 (workflow_outputs) サービス層 (T-A-21 / GAP-023)。

RLS が効く AsyncSession を受け取り workflow_outputs を読む。可視性は RLS (T-D-21)。
成果物は工程生成で作られるため read (一覧・取得・バージョン履歴) が中心。
書込は「編集 = ドキュメント AI (スティーブ) への修正依頼」による新バージョン
追加のみ (revise.py — 既存行の上書きはしない)。
"""

from __future__ import annotations

import json
import uuid as uuid_mod
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.schemas.outputs import OutputResponse


def is_uuid(value: str) -> bool:
    """path param の UUID 妥当性 (不正値は 500 ではなく 404 に落とすため)。"""
    try:
        uuid_mod.UUID(value)
    except ValueError:
        return False
    return True


_COLS = (
    "id, project_id, phase_id, stage, html_path, json_path, md_path, "
    "summary, version, meta, created_at, updated_at, deleted_at"
)


def _meta(row: Any) -> dict[str, object]:
    raw = row.meta
    if isinstance(raw, dict):
        return cast("dict[str, object]", raw)
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except ValueError:
            return {}
        return cast("dict[str, object]", parsed) if isinstance(parsed, dict) else {}
    return {}


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
        meta=_meta(row),
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
    if not is_uuid(output_id):
        return None
    res = await session.execute(
        text(
            f"select {_COLS} from public.workflow_outputs "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": output_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def list_versions(session: AsyncSession, output_id: str) -> list[OutputResponse]:
    """同一成果物チェーン (project + stage + phase が一致) のバージョン履歴。

    workflow_outputs に親リンク列は無く、チェーンは (project_id, stage,
    phase_id) の一致で定義される (version 連番)。返り値 [] = 不可視/不在。
    """
    src = await get_output(session, output_id)
    if src is None:
        return []
    res = await session.execute(
        text(
            f"select {_COLS} from public.workflow_outputs "
            "where project_id = cast(:pid as uuid) "
            "and stage = cast(:st as workflow_stage_enum) "
            "and (phase_id is not distinct from cast(:ph as uuid)) "
            "and deleted_at is null order by version asc"
        ),
        {"pid": src.project_id, "st": src.stage, "ph": src.phase_id},
    )
    return [_row_to_response(r) for r in res.all()]


async def insert_version(
    session: AsyncSession,
    *,
    src: OutputResponse,
    html_path: str,
    meta: dict[str, object],
) -> OutputResponse:
    """チェーンの次バージョン行を追加する (revise 専用 — 既存行は不変)。

    改訂は HTML に対して行われるため json/md は「未生成」(null) で正直に持つ
    (旧版の json/md を新版の内容として見せない)。
    """
    res = await session.execute(
        text(
            "insert into public.workflow_outputs "
            "(project_id, phase_id, stage, html_path, summary, version, meta) "
            "select project_id, phase_id, stage, :hp, summary, "
            "(select max(version) + 1 from public.workflow_outputs "
            " where project_id = cast(:pid as uuid) "
            " and stage = cast(:st as workflow_stage_enum) "
            " and (phase_id is not distinct from cast(:ph as uuid)) "
            " and deleted_at is null), "
            "cast(:meta as jsonb) "
            "from public.workflow_outputs where id = cast(:id as uuid) "
            f"returning {_COLS}"
        ),
        {
            "hp": html_path,
            "pid": src.project_id,
            "st": src.stage,
            "ph": src.phase_id,
            "meta": json.dumps(meta, ensure_ascii=False),
            "id": src.id,
        },
    )
    return _row_to_response(res.one())
