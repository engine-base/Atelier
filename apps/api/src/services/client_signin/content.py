"""S-L03 クライアントポータル実コンテンツ (GAP-029 / R-T08 致命級・経営者承認済)。

client_portal JWT で読める project 限定の read API 群:
  - overview: 工程 (進捗バー) + 実進捗% + 運営表示 + 招待リンク有効期限
  - outputs: stage 毎の最新版 (実在フォーマットのみ)
  - mocks: screen_name 毎の最新版
  - comments: 自分 (招待) のコメント + それへの運営返信のみ (他クライアント・
    社内スレッドは返さない)
  - create_comment: comment スコープ必須。target は当該 project の成果物 /
    モックに限定 (越境 target は target_not_found)

R-T08: 全関数が JWT の project_id claim と要求 project_id の一致を強制
(cross_project)。DB は capability (署名済 JWT) を信頼源に service session で
project_id 限定 SELECT する。scopes: read 系は "view"、投稿は "comment" 必須。
"""

from __future__ import annotations

import math
import uuid as uuid_mod
from datetime import UTC, datetime
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.client_signin import (
    ClientCommentCreate,
    ClientCommentItem,
    ClientCommentUpdate,
    ClientMockItem,
    ClientMocksResponse,
    ClientOutputItem,
    ClientPhaseItem,
    ClientProjectOverview,
)
from src.schemas.storage import ContentUrlResponse
from src.services.client_signin import (
    ClientSigninError,
    _service_session_factory,  # pyright: ignore[reportPrivateUsage]  # 同一パッケージ内共有
)
from src.services.client_signin.staff_notify import notify_staff_of_client_comment
from src.services.mocks.artifacts import FILEDB_PREFIX, MOCKDB_PREFIX, build_content_url
from src.services.outputs.content_kind import filedb_kind
from src.storage_signing import StorageSigningError, create_signed_download_url

STAGE_LABEL: dict[str, str] = {
    "proposal": "提案書",
    "estimate": "見積書",
    "hearing": "ヒアリングサマリー",
    "requirements": "要件定義書",
    "architecture": "アーキテクチャ設計",
    "design": "デザイン",
    "breakdown": "機能分解",
    "tasks": "タスク一覧",
    "implementation": "実装進捗レポート",
    "verification": "検証レポート",
    "delivery": "納品書",
    "contract": "契約書",
    "nda": "NDA",
    "invoice": "請求書",
}


def _require_project(claims: dict[str, Any], requested_project_id: str) -> str:
    """R-T08 越境拒否: JWT の project_id claim と一致しなければ cross_project。"""
    claim_project_id = str(claims.get("project_id"))
    if claim_project_id != requested_project_id:
        raise ClientSigninError("cross_project", "client token is not authorized for this project")
    return claim_project_id


def _require_scope(claims: dict[str, Any], scope: str) -> None:
    scopes_claim = claims.get("scopes")
    scopes = (
        [str(s) for s in cast("list[object]", scopes_claim)]
        if isinstance(scopes_claim, list)
        else []
    )
    if scope not in scopes:
        raise ClientSigninError("forbidden_scope", f"'{scope}' scope is required")


def _is_uuid(value: str) -> bool:
    try:
        uuid_mod.UUID(value)
    except ValueError:
        return False
    return True


async def _project_exists(session: AsyncSession, project_id: str) -> bool:
    res = await session.execute(
        text("select 1 from public.projects where id = cast(:p as uuid) and deleted_at is null"),
        {"p": project_id},
    )
    return res.first() is not None


async def get_overview(
    *, claims: dict[str, Any], requested_project_id: str
) -> ClientProjectOverview:
    """工程進捗 + 運営表示 + 招待リンク有効期限 (すべて実データ)。"""
    project_id = _require_project(claims, requested_project_id)
    _require_scope(claims, "view")
    invitation_id = str(claims.get("invitation_id", ""))
    factory = _service_session_factory()
    async with factory() as session:
        if not await _project_exists(session, project_id):
            raise ClientSigninError("project_not_found", "project not found")
        phases_res = await session.execute(
            text(
                'select name, "order", status from public.phases '
                'where project_id = cast(:p as uuid) order by "order"'
            ),
            {"p": project_id},
        )
        phases = [
            ClientPhaseItem(name=str(r.name), order=int(r.order), status=str(r.status))
            for r in phases_res.all()
        ]
        op_res = await session.execute(
            text(
                "select w.name as workspace_name, u.display_name as owner_name "
                "from public.projects p "
                "join public.workspaces w on w.id = p.workspace_id "
                "left join public.users u on u.id = w.owner_user_id and u.deleted_at is null "
                "where p.id = cast(:p as uuid)"
            ),
            {"p": project_id},
        )
        op = op_res.first()
        link_expires_at: datetime | None = None
        link_remaining_days: int | None = None
        if _is_uuid(invitation_id):
            inv_res = await session.execute(
                text(
                    "select expires_at from public.client_invitations "
                    "where id = cast(:i as uuid) and revoked_at is null"
                ),
                {"i": invitation_id},
            )
            inv = inv_res.first()
            if inv is not None and inv.expires_at is not None:
                exp = cast("datetime", inv.expires_at)
                exp_aware = exp if exp.tzinfo else exp.replace(tzinfo=UTC)
                link_expires_at = exp_aware
                link_remaining_days = max(
                    0,
                    math.ceil((exp_aware - datetime.now(UTC)).total_seconds() / 86400),
                )
    completed = sum(1 for p in phases if p.status == "completed")
    countable = [p for p in phases if p.status != "skipped"]
    progress = round(completed * 100 / len(countable)) if countable else 0
    return ClientProjectOverview(
        phases=phases,
        progress_percent=progress,
        operator_workspace_name=(
            None if op is None or op.workspace_name is None else str(op.workspace_name)
        ),
        operator_name=(None if op is None or op.owner_name is None else str(op.owner_name)),
        link_expires_at=link_expires_at,
        link_remaining_days=link_remaining_days,
    )


async def list_outputs(
    *, claims: dict[str, Any], requested_project_id: str
) -> list[ClientOutputItem]:
    """stage 毎の最新版のみ。formats は実在するパスから導出 (創作しない)。"""
    project_id = _require_project(claims, requested_project_id)
    _require_scope(claims, "view")
    factory = _service_session_factory()
    async with factory() as session:
        if not await _project_exists(session, project_id):
            raise ClientSigninError("project_not_found", "project not found")
        res = await session.execute(
            text(
                "select distinct on (stage) id, stage, version, updated_at, summary, "
                "html_path is not null as has_html, json_path is not null as has_json, "
                "md_path is not null as has_md "
                "from public.workflow_outputs "
                "where project_id = cast(:p as uuid) and deleted_at is null "
                "order by stage, version desc"
            ),
            {"p": project_id},
        )
        rows = res.all()
    items = [
        ClientOutputItem(
            id=str(r.id),
            stage=str(r.stage),
            stage_label=STAGE_LABEL.get(str(r.stage), str(r.stage)),
            version=int(r.version),
            updated_at=r.updated_at,
            formats=[
                f
                for f, present in (("html", r.has_html), ("json", r.has_json), ("md", r.has_md))
                if present
            ],
            summary=(None if r.summary is None else str(r.summary)),
        )
        for r in rows
    ]
    items.sort(key=lambda i: i.updated_at, reverse=True)
    return items


async def get_output_content_url(
    *,
    claims: dict[str, Any],
    requested_project_id: str,
    output_id: str,
    fmt: str,
    base_url: str,
) -> ContentUrlResponse:
    """クライアントが共有済み成果物の中身を開くための署名付き URL (GAP-268 / 通し J23-05)。

    運営側 GET /outputs/{id}/content-url と同じ配信経路 (mockdb/filedb は自己署名 URL、
    それ以外は Storage 署名 URL)。可視性は「自 project の成果物」だけ — 他 project は
    存在ごと秘匿 (404)。view スコープ必須。
    """
    project_id = _require_project(claims, requested_project_id)
    _require_scope(claims, "view")
    if not _is_uuid(output_id):
        raise ClientSigninError("target_not_found", "output not found in this project")
    factory = _service_session_factory()
    async with factory() as session:
        if not await _project_exists(session, project_id):
            raise ClientSigninError("project_not_found", "project not found")
        row = (
            await session.execute(
                text(
                    "select html_path, json_path, md_path from public.workflow_outputs "
                    "where id = cast(:i as uuid) and project_id = cast(:p as uuid) "
                    "and deleted_at is null"
                ),
                {"i": output_id, "p": project_id},
            )
        ).first()
    if row is None:
        raise ClientSigninError("target_not_found", "output not found in this project")
    path = {"html": row.html_path, "json": row.json_path, "md": row.md_path}.get(fmt)
    if path is None:
        raise ClientSigninError("format_not_available", f"{fmt} is not available")
    path = str(path)
    if path.startswith(MOCKDB_PREFIX) or path.startswith(FILEDB_PREFIX):
        url = build_content_url(base_url, output_id, resource="outputs")
        if not path.startswith(FILEDB_PREFIX):
            return ContentUrlResponse(url=url, kind="html")
        kind, file_name, mime = await filedb_kind(path)
        return ContentUrlResponse(url=url, kind=kind, file_name=file_name, mime=mime)
    try:
        url = await create_signed_download_url(path)
    except StorageSigningError as exc:
        raise ClientSigninError("storage_unavailable", str(exc)) from exc
    return ContentUrlResponse(url=url)


async def list_mocks(*, claims: dict[str, Any], requested_project_id: str) -> ClientMocksResponse:
    """screen_name 毎の最新版のみ。"""
    project_id = _require_project(claims, requested_project_id)
    _require_scope(claims, "view")
    factory = _service_session_factory()
    async with factory() as session:
        if not await _project_exists(session, project_id):
            raise ClientSigninError("project_not_found", "project not found")
        res = await session.execute(
            text(
                "select distinct on (screen_name) id, screen_name, version, updated_at "
                "from public.mocks "
                "where project_id = cast(:p as uuid) and deleted_at is null "
                "order by screen_name, version desc"
            ),
            {"p": project_id},
        )
        rows = res.all()
    items = [
        ClientMockItem(
            id=str(r.id),
            screen_name=str(r.screen_name),
            version=int(r.version),
            updated_at=r.updated_at,
        )
        for r in rows
    ]
    items.sort(key=lambda i: i.updated_at, reverse=True)
    return ClientMocksResponse(items=items, total_screens=len(items))


_COMMENT_TARGET_SQL = (
    "left join public.workflow_outputs wo "
    "  on c.target_type = 'workflow_output' and wo.id = c.target_id "
    "left join public.mocks m "
    "  on c.target_type = 'mock' and m.id = c.target_id "
)


async def list_comments(
    *, claims: dict[str, Any], requested_project_id: str
) -> list[ClientCommentItem]:
    """自分 (この招待) のコメント + それへの返信のみ。

    他クライアント・社内のみのスレッドは返さない (最小開示)。返信の author は
    staff の表示名 (未設定は null — 創作しない)。target が当該 project に属する
    ことも突合する (defense-in-depth)。
    """
    project_id = _require_project(claims, requested_project_id)
    _require_scope(claims, "view")
    invitation_id = str(claims.get("invitation_id", ""))
    if not _is_uuid(invitation_id):
        raise ClientSigninError("invalid_client_token", "missing invitation_id claim")
    factory = _service_session_factory()
    async with factory() as session:
        if not await _project_exists(session, project_id):
            raise ClientSigninError("project_not_found", "project not found")
        res = await session.execute(
            # GAP-321 (通し J23-05 再測): **返信が自分のコメントの上に並んでいた**。
            # 平坦な created_at desc だと「運営の返信 → 自分の発言」の順になり、
            # どれへの返事なのか読めない。スレッド (親の新しい順 → 親の直下に返信を
            # 古い順) で返し、parent_comment_id も返して画面が入れ子にできるようにする。
            text(
                "select c.id, c.target_type, c.target_id, c.content, c.created_at, "
                "c.author_invitation_id, c.parent_comment_id, u.display_name as staff_name, "
                "wo.stage as output_stage, m.screen_name as mock_screen, "
                "coalesce(root.created_at, c.created_at) as thread_at "
                "from public.comments c " + _COMMENT_TARGET_SQL + "left join public.users u "
                "  on u.id = c.author_user_id and u.deleted_at is null "
                "left join public.comments root on root.id = c.parent_comment_id "
                "where c.deleted_at is null "
                "and coalesce(wo.project_id, m.project_id) = cast(:p as uuid) "
                "and (c.author_invitation_id = cast(:inv as uuid) "
                "     or c.parent_comment_id in (select id from public.comments "
                "        where author_invitation_id = cast(:inv as uuid) "
                "        and deleted_at is null)) "
                "order by thread_at desc, "
                "  (c.parent_comment_id is not null), c.created_at asc limit 100"
            ),
            {"p": project_id, "inv": invitation_id},
        )
        rows = res.all()
    items: list[ClientCommentItem] = []
    for r in rows:
        is_client = r.author_invitation_id is not None and str(r.author_invitation_id) == str(
            invitation_id
        )
        if r.output_stage is not None:
            label = STAGE_LABEL.get(str(r.output_stage), str(r.output_stage))
        elif r.mock_screen is not None:
            label = f"モック: {r.mock_screen}"
        else:
            label = None
        items.append(
            ClientCommentItem(
                id=str(r.id),
                target_type=str(r.target_type),
                target_id=str(r.target_id),
                target_label=label,
                content=str(r.content),
                author_name=(None if r.staff_name is None else str(r.staff_name)),
                is_client_author=is_client,
                created_at=r.created_at,
                parent_comment_id=(
                    None if r.parent_comment_id is None else str(r.parent_comment_id)
                ),
            )
        )
    return items


async def create_comment(
    *, claims: dict[str, Any], requested_project_id: str, data: ClientCommentCreate
) -> ClientCommentItem:
    """クライアントのコメント投稿 (comment スコープ必須・target は自 project 限定)。"""
    project_id = _require_project(claims, requested_project_id)
    _require_scope(claims, "comment")
    invitation_id = str(claims.get("invitation_id", ""))
    if not _is_uuid(invitation_id):
        raise ClientSigninError("invalid_client_token", "missing invitation_id claim")
    if not _is_uuid(data.target_id):
        raise ClientSigninError("target_not_found", "comment target not found in this project")
    table = "workflow_outputs" if data.target_type == "workflow_output" else "mocks"
    factory = _service_session_factory()
    async with factory() as session:
        try:
            target_res = await session.execute(
                text(
                    f"select id, {'stage' if table == 'workflow_outputs' else 'screen_name'} as label_src "
                    f"from public.{table} "
                    "where id = cast(:t as uuid) and project_id = cast(:p as uuid) "
                    "and deleted_at is null"
                ),
                {"t": data.target_id, "p": project_id},
            )
            target = target_res.first()
            if target is None:
                # R-T08: 他 project の target は存在ごと秘匿 (404)
                raise ClientSigninError(
                    "target_not_found", "comment target not found in this project"
                )
            res = await session.execute(
                text(
                    "insert into public.comments "
                    "(target_type, target_id, author_invitation_id, content) "
                    "values (cast(:tt as comment_target_type_enum), cast(:t as uuid), "
                    " cast(:inv as uuid), :c) "
                    "returning id, created_at"
                ),
                {
                    "tt": data.target_type,
                    "t": data.target_id,
                    "inv": invitation_id,
                    "c": data.content,
                },
            )
            row = res.one()
            await AuditWriter(session).write(
                AuditEvent(
                    action="client.comment.create",
                    target_type="comment",
                    actor_type="anonymous",
                    actor_id=f"client:{invitation_id}",
                    target_id=str(row.id),
                    after={
                        "project_id": project_id,
                        "target_type": data.target_type,
                        "target_id": data.target_id,
                    },
                )
            )
            if data.target_type == "workflow_output":
                label = STAGE_LABEL.get(str(target.label_src), str(target.label_src))
            else:
                label = f"モック: {target.label_src}"
            # GAP-266 (通し J23-01): 運営に届かないコメントは機能として成立しない。
            # 保存と同じトランザクションで通知 + 監査ログ (送信自体は best-effort)。
            await notify_staff_of_client_comment(
                session,
                project_id=project_id,
                invitation_id=invitation_id,
                comment_id=str(row.id),
                target_label=label,
                content=data.content,
            )
            await session.commit()
        except Exception:
            await session.rollback()
            raise
    return ClientCommentItem(
        id=str(row.id),
        target_type=data.target_type,
        target_id=data.target_id,
        target_label=label,
        content=data.content,
        author_name=None,
        is_client_author=True,
        created_at=row.created_at,
    )


# コメントが「この招待の・この project の・未削除の」ものであることを 1 文で言う (GAP-267)
_OWN_COMMENT_WHERE = (
    "c.id = cast(:id as uuid) and c.deleted_at is null "
    "and c.author_invitation_id = cast(:inv as uuid) "
    "and exists (select 1 from public.comments c2 "
    "  left join public.workflow_outputs wo "
    "    on c2.target_type = 'workflow_output' and wo.id = c2.target_id "
    "  left join public.mocks m on c2.target_type = 'mock' and m.id = c2.target_id "
    "  where c2.id = c.id and coalesce(wo.project_id, m.project_id) = cast(:p as uuid))"
)


async def update_comment(
    *,
    claims: dict[str, Any],
    requested_project_id: str,
    comment_id: str,
    data: ClientCommentUpdate,
) -> ClientCommentItem:
    """クライアント自身のコメントの本文修正 (GAP-267 / 通し J23-03)。

    自分 (この招待) が書いた・未削除・自 project のコメントだけ。他人のコメントや
    他 project のものは存在ごと秘匿 (404)。comment スコープ必須。
    """
    project_id = _require_project(claims, requested_project_id)
    _require_scope(claims, "comment")
    invitation_id = str(claims.get("invitation_id", ""))
    if not _is_uuid(invitation_id):
        raise ClientSigninError("invalid_client_token", "missing invitation_id claim")
    if not _is_uuid(comment_id):
        raise ClientSigninError("comment_not_found", "comment not found")
    factory = _service_session_factory()
    async with factory() as session:
        try:
            res = await session.execute(
                text(
                    "update public.comments c set content = :c, updated_at = now() "
                    "where " + _OWN_COMMENT_WHERE + " "
                    "returning c.id, c.target_type, c.target_id, c.created_at"
                ),
                {"id": comment_id, "inv": invitation_id, "p": project_id, "c": data.content},
            )
            row = res.first()
            if row is None:
                raise ClientSigninError("comment_not_found", "comment not found")
            await AuditWriter(session).write(
                AuditEvent(
                    action="client.comment.update",
                    target_type="comment",
                    actor_type="anonymous",
                    actor_id=f"client:{invitation_id}",
                    target_id=str(row.id),
                    after={"project_id": project_id, "content_length": len(data.content)},
                )
            )
            label = await _target_label(session, str(row.target_type), str(row.target_id))
            await session.commit()
        except Exception:
            await session.rollback()
            raise
    return ClientCommentItem(
        id=str(row.id),
        target_type=str(row.target_type),
        target_id=str(row.target_id),
        target_label=label,
        content=data.content,
        author_name=None,
        is_client_author=True,
        created_at=row.created_at,
    )


async def delete_comment(
    *, claims: dict[str, Any], requested_project_id: str, comment_id: str
) -> None:
    """クライアント自身のコメントの取り消し (論理削除 / GAP-267 / 通し J23-03)。"""
    project_id = _require_project(claims, requested_project_id)
    _require_scope(claims, "comment")
    invitation_id = str(claims.get("invitation_id", ""))
    if not _is_uuid(invitation_id):
        raise ClientSigninError("invalid_client_token", "missing invitation_id claim")
    if not _is_uuid(comment_id):
        raise ClientSigninError("comment_not_found", "comment not found")
    factory = _service_session_factory()
    async with factory() as session:
        try:
            res = await session.execute(
                text(
                    "update public.comments c set deleted_at = now(), status = 'deleted', "
                    "updated_at = now() where " + _OWN_COMMENT_WHERE + " returning c.id"
                ),
                {"id": comment_id, "inv": invitation_id, "p": project_id},
            )
            if res.first() is None:
                raise ClientSigninError("comment_not_found", "comment not found")
            await AuditWriter(session).write(
                AuditEvent(
                    action="client.comment.delete",
                    target_type="comment",
                    actor_type="anonymous",
                    actor_id=f"client:{invitation_id}",
                    target_id=comment_id,
                    after={"project_id": project_id},
                )
            )
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def _target_label(session: AsyncSession, target_type: str, target_id: str) -> str | None:
    if target_type == "workflow_output":
        stage = (
            await session.execute(
                text("select stage from public.workflow_outputs where id = cast(:i as uuid)"),
                {"i": target_id},
            )
        ).scalar_one_or_none()
        return None if stage is None else STAGE_LABEL.get(str(stage), str(stage))
    name = (
        await session.execute(
            text("select screen_name from public.mocks where id = cast(:i as uuid)"),
            {"i": target_id},
        )
    ).scalar_one_or_none()
    return None if name is None else f"モック: {name}"
