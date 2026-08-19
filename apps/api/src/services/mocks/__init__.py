"""Mock CRUD + バージョン管理 サービス層 (T-A-33)。

RLS が効く AsyncSession を受け取り mocks を操作する。可視性/権限は RLS (T-D-17)。
状態変更で audit_logs 記録。version + parent_mock_id でバージョンチェーンを構成。
"""

from __future__ import annotations

import json
import uuid
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
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
    "delivery_phase_id, meta_tags, created_at, updated_at, deleted_at"
)


class MockPhaseFrozen(Exception):
    """GAP-152: 確定済みフェーズに帰属する行への破壊的操作 (→ 409)。"""


async def _guard_frozen(session: AsyncSession, mock: MockResponse) -> None:
    from src.services.flow.phases import frozen_phase_of

    name = await frozen_phase_of(session, delivery_phase_id=mock.delivery_phase_id)
    if name is not None:
        raise MockPhaseFrozen(
            f"「{name}」は確定済みのため変更できません。追加・修正は現在のフェーズで行ってください"
        )


def _meta(value: object) -> dict[str, object] | None:
    if value is None:
        return None
    if isinstance(value, str):
        loaded: Any = json.loads(value)
        return loaded
    if isinstance(value, dict):
        return cast("dict[str, object]", value)
    return None


def _row_to_response(row: Any) -> MockResponse:
    return MockResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        screen_name=str(row.screen_name),
        html_storage_path=str(row.html_storage_path),
        version=int(row.version),
        parent_mock_id=(None if row.parent_mock_id is None else str(row.parent_mock_id)),
        delivery_phase_id=(None if row.delivery_phase_id is None else str(row.delivery_phase_id)),
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
    delivery_phase_id: str | None = None,
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
    if delivery_phase_id is not None:
        # GAP-152: フェーズ切替 (確定フェーズのスナップショット閲覧)
        where.append("delivery_phase_id = cast(:dph as uuid)")
        params["dph"] = delivery_phase_id
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


class MockVersionConflict(Exception):
    """GAP-155: 同時改訂の衝突 (同 project+画面+version が先に作られた)。

    黙って積み直すと「後勝ちに先勝ちの変更が含まれない」lost update に
    見えるため、リトライせず 409 で誠実にユーザーへ返す。"""


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
    # GAP-152: 新規行は常に active フェーズに帰属 — 確定フェーズには何も足せない
    from src.services.flow.phases import ensure_active_phase

    phase = await ensure_active_phase(session, project_id=project_id)
    await session.execute(
        text(
            "insert into public.mocks "
            "(id, project_id, screen_name, html_storage_path, version, parent_mock_id, "
            " delivery_phase_id, meta_tags) "
            "values (cast(:id as uuid), cast(:pid as uuid), :sn, :path, :ver, "
            "        cast(:parent as uuid), cast(:dph as uuid), cast(:meta as jsonb))"
        ),
        {
            "id": mock_id,
            "pid": project_id,
            "sn": screen_name,
            "path": html_storage_path,
            "ver": version,
            "parent": parent_mock_id,
            "dph": phase.id,
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
    # GAP-155: (project, 画面, version) 一意 — 同時改訂は savepoint で受けて
    # 409 相当の typed error にする (黙って積み直さない)
    try:
        async with session.begin_nested():
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
    except IntegrityError as exc:
        raise MockVersionConflict(
            f"「{parent.screen_name}」は他のメンバーが同時に改訂しました "
            f"(v{next_version} が先に作成)。最新を確認して再実行してください"
        ) from exc
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
    src = await get_mock(session, mock_id)
    if src is None:
        return None
    await _guard_frozen(session, src)  # GAP-152: 確定フェーズの行は不変
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
    src = await get_mock(session, mock_id)
    if src is None:
        return False
    await _guard_frozen(session, src)  # GAP-152
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


async def duplicate_version(
    session: AsyncSession, *, actor_id: str, mock_id: str
) -> MockResponse | None:
    """バージョン複製 (GAP-024 — 「…」メニュー)。同内容の新バージョンを作る。

    storage オブジェクトは同一パスを参照 (内容同一の明示 — コピー偽装をしない)。
    返り値 None = mock 不可視/不在。
    """
    src = await get_mock(session, mock_id)
    if src is None:
        return None
    created = await create_version(
        session,
        actor_id=actor_id,
        mock_id=mock_id,
        data=MockVersionCreate(
            html_storage_path=src.html_storage_path,
            meta_tags={"duplicated_from_version": src.version},
        ),
    )
    if created is not None:
        await AuditWriter(session).write(
            AuditEvent(
                action="mock.duplicate",
                target_type="mock",
                actor_type="user",
                actor_id=actor_id,
                target_id=created.id,
                after={"source_mock_id": mock_id, "source_version": src.version},
            )
        )
    return created


async def discard_version(session: AsyncSession, *, actor_id: str, mock_id: str) -> bool:
    """バージョン破棄 (GAP-024 — 「…」メニュー)。当該バージョン行を soft delete。

    同 screen で唯一の生存バージョンは破棄不可 (ValueError → 409)。
    返り値 False = mock 不可視/不在。
    """
    src = await get_mock(session, mock_id)
    if src is None:
        return False
    await _guard_frozen(session, src)  # GAP-152: 確定フェーズの版は破棄できない
    res = await session.execute(
        text(
            "select count(*) from public.mocks "
            "where project_id = cast(:pid as uuid) and screen_name = :sn "
            "and deleted_at is null"
        ),
        {"pid": src.project_id, "sn": src.screen_name},
    )
    if int(res.scalar_one()) <= 1:
        raise ValueError("cannot discard the only remaining version")
    await session.execute(
        text(
            "update public.mocks set deleted_at = now() "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": mock_id},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="mock.discard",
            target_type="mock",
            actor_type="user",
            actor_id=actor_id,
            target_id=mock_id,
            after={"screen_name": src.screen_name, "version": src.version},
        )
    )
    return True
