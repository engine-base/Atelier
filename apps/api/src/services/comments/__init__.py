"""コメント (comments) サービス層 (T-A-22)。

RLS が効く AsyncSession を受け取り comments を操作する。可視性/権限は RLS:
  - SELECT/INSERT: user_can_see_comment_target(target_type, target_id)
  - INSERT: author_user_id = auth.uid()
  - UPDATE: 自分のコメントのみ
  - DELETE: 自分 or 対象オーナー
作成者は常にログインユーザー (author_user_id = actor_id)。状態変更で audit_logs。
deleted_at で論理削除済の行は一覧/取得から除外する。
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.comments import CommentCreate, CommentResponse, CommentUpdate

_COLS = (
    "id, target_type, target_id, target_element_id, author_user_id, author_invitation_id, "
    "content, status, parent_comment_id, created_at, updated_at"
)


def _row_to_response(row: Any) -> CommentResponse:
    return CommentResponse(
        id=str(row.id),
        target_type=row.target_type,
        target_id=str(row.target_id),
        target_element_id=(None if row.target_element_id is None else str(row.target_element_id)),
        author_user_id=(None if row.author_user_id is None else str(row.author_user_id)),
        author_invitation_id=(
            None if row.author_invitation_id is None else str(row.author_invitation_id)
        ),
        content=str(row.content),
        status=str(row.status),
        parent_comment_id=(None if row.parent_comment_id is None else str(row.parent_comment_id)),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_comments(
    session: AsyncSession, *, target_type: str, target_id: str
) -> list[CommentResponse]:
    res = await session.execute(
        text(
            f"select {_COLS} from public.comments "
            "where target_type = cast(:tt as comment_target_type_enum) "
            "and target_id = cast(:tid as uuid) and deleted_at is null "
            "order by created_at"
        ),
        {"tt": target_type, "tid": target_id},
    )
    return [_row_to_response(r) for r in res.all()]


async def get_comment(session: AsyncSession, comment_id: str) -> CommentResponse | None:
    res = await session.execute(
        text(
            f"select {_COLS} from public.comments "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": comment_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_comment(
    session: AsyncSession, *, actor_id: str, data: CommentCreate
) -> CommentResponse | None:
    visible = await session.execute(
        text(
            "select public.user_can_see_comment_target("
            "cast(:tt as comment_target_type_enum)::text, cast(:tid as uuid))"
        ),
        {"tt": data.target_type, "tid": data.target_id},
    )
    if not bool(visible.scalar_one()):
        return None
    new_id = str(uuid.uuid4())
    res = await session.execute(
        text(
            "insert into public.comments "
            "(id, target_type, target_id, target_element_id, author_user_id, "
            " content, parent_comment_id) "
            "values (cast(:id as uuid), cast(:tt as comment_target_type_enum), "
            " cast(:tid as uuid), :elem, cast(:author as uuid), :content, "
            " cast(:parent as uuid)) returning id"
        ),
        {
            "id": new_id,
            "tt": data.target_type,
            "tid": data.target_id,
            "elem": data.target_element_id,
            "author": actor_id,
            "content": data.content,
            "parent": data.parent_comment_id,
        },
    )
    if res.scalar_one_or_none() is None:  # pragma: no cover - RLS は通常 raise する
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="comment.create",
            target_type="comment",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={
                "target_type": data.target_type,
                "target_id": data.target_id,
                "parent_comment_id": data.parent_comment_id,
            },
        )
    )
    return await get_comment(session, new_id)


async def update_comment(
    session: AsyncSession, *, actor_id: str, comment_id: str, data: CommentUpdate
) -> CommentResponse | None:
    sets: list[str] = []
    params: dict[str, object] = {"id": comment_id}
    if data.content is not None:
        sets.append("content = :content")
        params["content"] = data.content
    if data.status is not None:
        sets.append("status = :st")
        params["st"] = data.status
    if not sets:
        return await get_comment(session, comment_id)
    res = await session.execute(
        text(
            f"update public.comments set {', '.join(sets)} "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="comment.update",
            target_type="comment",
            actor_type="user",
            actor_id=actor_id,
            target_id=comment_id,
            after={k: v for k, v in params.items() if k != "id"},
        )
    )
    return await get_comment(session, comment_id)


async def delete_comment(session: AsyncSession, *, actor_id: str, comment_id: str) -> bool:
    """論理削除 (deleted_at セット + status='deleted')。

    RLS comments_update_self は自分のコメントのみ許可するため、対象オーナーによる
    モデレーションは別途 (T-A-42 admin) で扱う。ここでは作成者本人の取消のみ。
    """
    res = await session.execute(
        text(
            "update public.comments set deleted_at = now(), status = 'deleted' "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        {"id": comment_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="comment.delete",
            target_type="comment",
            actor_type="user",
            actor_id=actor_id,
            target_id=comment_id,
        )
    )
    return True
