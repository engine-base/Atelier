"""Mock CRUD + バージョン管理 サービス層 (T-A-33)。

RLS が効く AsyncSession を受け取り mocks を操作する。可視性/権限は RLS (T-D-17)。
状態変更で audit_logs 記録。version + parent_mock_id でバージョンチェーンを構成。
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.mocks import (
    MockCreate,
    MockResponse,
    MockUpdate,
    MockVersionCreate,
)

_COLS = (
    "id, project_id, screen_name, html_storage_path, version, parent_mock_id, "
    "meta_tags, created_at, updated_at, deleted_at"
)


def _meta(value: object) -> dict[str, object] | None:
    if value is None:
        return None
    if isinstance(value, str):
        loaded: Any = json.loads(value)
        return loaded
    if isinstance(value, dict):
        return value
    return None


def _row_to_response(row: Any) -> MockResponse:
    return MockResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        screen_name=str(row.screen_name),
        html_storage_path=str(row.html_storage_path),
        version=int(row.version),
        parent_mock_id=(None if row.parent_mock_id is None else str(row.parent_mock_id)),
        meta_tags=_meta(row.meta_tags),
        deleted_at=row.deleted_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_mocks(
    session: AsyncSession,
    *,
    project_id: str | None = None,
    screen_name: str | None = None,
    limit: int = 50,
) -> list[MockResponse]:
    limit = max(1, min(limit, 200))
    where = ["deleted_at is null"]
    params: dict[str, object] = {"lim": limit}
    if project_id is not None:
        where.append("project_id = cast(:pid as uuid)")
        params["pid"] = project_id
    if screen_name is not None:
        where.append("screen_name = :sn")
        params["sn"] = screen_name
    res = await session.execute(
        text(
            f"select {_COLS} from public.mocks "
            f"where {' and '.join(where)} order by screen_name, version desc limit :lim"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_mock(session: AsyncSession, mock_id: str) -> MockResponse | None:
    res = await session.execute(
        text(
            f"select {_COLS} from public.mocks where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": mock_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def list_versions(session: AsyncSession, mock_id: str) -> list[MockResponse]:
    """同 project / screen_name のバージョン履歴 (version 昇順)。"""
    res = await session.execute(
        text(
            f"select {_COLS} from public.mocks "
            "where deleted_at is null and (project_id, screen_name) = "
            "  (select project_id, screen_name from public.mocks where id = cast(:id as uuid)) "
            "order by version"
        ),
        {"id": mock_id},
    )
    return [_row_to_response(r) for r in res.all()]


async def _insert_mock(
    session: AsyncSession,
    *,
    mock_id: str,
    project_id: str,
    screen_name: str,
    html_storage_path: str,
    version: int,
    parent_mock_id: str | None,
    meta_tags: dict[str, object] | None,
) -> None:
    await session.execute(
        text(
            "insert into public.mocks "
            "(id, project_id, screen_name, html_storage_path, version, parent_mock_id, meta_tags) "
            "values (cast(:id as uuid), cast(:pid as uuid), :sn, :path, :ver, "
            "        cast(:parent as uuid), cast(:meta as jsonb))"
        ),
        {
            "id": mock_id,
            "pid": project_id,
            "sn": screen_name,
            "path": html_storage_path,
            "ver": version,
            "parent": parent_mock_id,
            "meta": None if meta_tags is None else json.dumps(meta_tags),
        },
    )


async def create_mock(session: AsyncSession, *, actor_id: str, data: MockCreate) -> MockResponse:
    new_id = str(uuid.uuid4())
    await _insert_mock(
        session,
        mock_id=new_id,
        project_id=data.project_id,
        screen_name=data.screen_name,
        html_storage_path=data.html_storage_path,
        version=1,
        parent_mock_id=None,
        meta_tags=data.meta_tags,
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="mock.create",
            target_type="mock",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={"screen_name": data.screen_name, "version": 1},
        )
    )
    created = await get_mock(session, new_id)
    if created is None:  # pragma: no cover
        raise RuntimeError("created mock not visible after insert")
    return created


async def create_version(
    session: AsyncSession, *, actor_id: str, mock_id: str, data: MockVersionCreate
) -> MockResponse | None:
    """mock_id を親に新バージョンを作る。親が不可視なら None。"""
    parent = await get_mock(session, mock_id)
    if parent is None:
        return None
    # 同 screen の最大 version + 1
    res = await session.execute(
        text(
            "select coalesce(max(version), 0) from public.mocks "
            "where project_id = cast(:pid as uuid) and screen_name = :sn"
        ),
        {"pid": parent.project_id, "sn": parent.screen_name},
    )
    next_version = int(res.scalar_one()) + 1
    new_id = str(uuid.uuid4())
    await _insert_mock(
        session,
        mock_id=new_id,
        project_id=parent.project_id,
        screen_name=parent.screen_name,
        html_storage_path=data.html_storage_path,
        version=next_version,
        parent_mock_id=mock_id,
        meta_tags=data.meta_tags,
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="mock.version_create",
            target_type="mock",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={"screen_name": parent.screen_name, "version": next_version, "parent": mock_id},
        )
    )
    return await get_mock(session, new_id)


async def update_mock(
    session: AsyncSession, *, actor_id: str, mock_id: str, data: MockUpdate
) -> MockResponse | None:
    sets: list[str] = []
    params: dict[str, object] = {"id": mock_id}
    if data.html_storage_path is not None:
        sets.append("html_storage_path = :path")
        params["path"] = data.html_storage_path
    if data.meta_tags is not None:
        sets.append("meta_tags = cast(:meta as jsonb)")
        params["meta"] = json.dumps(data.meta_tags)
    if not sets:
        return await get_mock(session, mock_id)
    res = await session.execute(
        text(
            f"update public.mocks set {', '.join(sets)} "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="mock.update",
            target_type="mock",
            actor_type="user",
            actor_id=actor_id,
            target_id=mock_id,
        )
    )
    return await get_mock(session, mock_id)


async def delete_mock(session: AsyncSession, *, actor_id: str, mock_id: str) -> bool:
    res = await session.execute(
        text(
            "update public.mocks set deleted_at = now() "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        {"id": mock_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="mock.delete",
            target_type="mock",
            actor_type="user",
            actor_id=actor_id,
            target_id=mock_id,
        )
    )
    return True
