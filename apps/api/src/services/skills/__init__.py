"""スキル管理 サービス層 (T-A-49 / F-007)。

E-009 skills の write（create/update/delete）+ AI 社員への装着。
skills は RLS で write 禁止 (skills_no_insert/update/delete) のため、
**service_role 相当のセッション (RLS バイパス)** で書き込む。呼出元 (route) で
is_admin gate 済を前提とし、全 write を audit_logs に記録する。
"""

from __future__ import annotations

import asyncio
import uuid
from functools import lru_cache
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.audit import AuditEvent, AuditWriter
from src.db.session import create_engine, create_session_factory
from src.schemas.admin import AdminSkillResponse
from src.schemas.skills import (
    SkillAttachRequest,
    SkillCreate,
    SkillLiteResponse,
    SkillUpdate,
)

_COLS = (
    "id, name, version, description, content_md, assets_storage_path, "
    "allowed_employee_roles, allowed_employee_ids, is_active, created_at, updated_at"
)


@lru_cache(maxsize=8)
def _session_factory_for_loop(loop_key: int) -> async_sessionmaker[AsyncSession]:
    """service_role 相当の sessionmaker。RLS バイパス用 (role を下げない)。

    asyncpg の接続は event loop を跨いで再利用できないため、実行中 loop 毎に
    engine を分離してキャッシュする (本番 uvicorn は単一 loop で挙動不変。
    テストの TestClient はブロック毎に新 loop を作るため必須)。
    """
    del loop_key  # cache key 専用
    return create_session_factory(create_engine())


def _service_session_factory() -> async_sessionmaker[AsyncSession]:
    """実行中 event loop に紐づく sessionmaker を返す。"""
    return _session_factory_for_loop(id(asyncio.get_running_loop()))


_service_session_factory.cache_clear = (  # pyright: ignore[reportAttributeAccessIssue, reportFunctionMemberAccess]
    _session_factory_for_loop.cache_clear
)


def _to_response(row: Any) -> AdminSkillResponse:
    raw_roles: list[object] = list(row.allowed_employee_roles) if row.allowed_employee_roles else []
    raw_ids: list[object] = list(row.allowed_employee_ids) if row.allowed_employee_ids else []
    return AdminSkillResponse(
        id=str(row.id),
        name=str(row.name),
        version=str(row.version),
        description=(None if row.description is None else str(row.description)),
        content_md=str(row.content_md),
        assets_storage_path=(
            None if row.assets_storage_path is None else str(row.assets_storage_path)
        ),
        allowed_employee_roles=[str(x) for x in raw_roles],
        allowed_employee_ids=[str(x) for x in raw_ids],
        is_active=bool(row.is_active),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def create_skill(*, actor_id: str, data: SkillCreate) -> AdminSkillResponse:
    new_id = str(uuid.uuid4())
    async with _service_session_factory()() as session:
        res = await session.execute(
            text(
                "insert into public.skills "
                "(id, name, version, description, content_md, assets_storage_path, "
                "allowed_employee_roles, allowed_employee_ids, is_active) "
                "values (cast(:id as uuid), :nm, :ver, :desc, :cm, :asp, "
                "cast(:roles as text[]), cast(:ids as uuid[]), :act) "
                f"returning {_COLS}"
            ),
            {
                "id": new_id,
                "nm": data.name,
                "ver": data.version,
                "desc": data.description,
                "cm": data.content_md,
                "asp": data.assets_storage_path,
                "roles": data.allowed_employee_roles,
                "ids": data.allowed_employee_ids,
                "act": data.is_active,
            },
        )
        row = res.first()
        await AuditWriter(session).write(
            AuditEvent(
                action="skill.create",
                target_type="skill",
                actor_type="user",
                actor_id=actor_id,
                target_id=new_id,
                after={"name": data.name, "version": data.version},
            )
        )
        await session.commit()
    return _to_response(row)


async def update_skill(
    *, actor_id: str, skill_id: str, data: SkillUpdate
) -> AdminSkillResponse | None:
    sets: list[str] = []
    params: dict[str, object] = {"id": skill_id}
    if data.content_md is not None:
        sets.append("content_md = :cm")
        params["cm"] = data.content_md
    if data.description is not None:
        sets.append("description = :desc")
        params["desc"] = data.description
    if data.assets_storage_path is not None:
        sets.append("assets_storage_path = :asp")
        params["asp"] = data.assets_storage_path
    if data.allowed_employee_roles is not None:
        sets.append("allowed_employee_roles = cast(:roles as text[])")
        params["roles"] = data.allowed_employee_roles
    if data.allowed_employee_ids is not None:
        sets.append("allowed_employee_ids = cast(:ids as uuid[])")
        params["ids"] = data.allowed_employee_ids
    if data.is_active is not None:
        sets.append("is_active = :act")
        params["act"] = data.is_active
    if not sets:
        # 変更なし: 現状を返す
        async with _service_session_factory()() as session:
            res = await session.execute(
                text(f"select {_COLS} from public.skills where id = cast(:id as uuid)"),
                {"id": skill_id},
            )
            row = res.first()
            return None if row is None else _to_response(row)
    sets.append("updated_at = now()")
    async with _service_session_factory()() as session:
        res = await session.execute(
            text(
                f"update public.skills set {', '.join(sets)} "
                f"where id = cast(:id as uuid) returning {_COLS}"
            ),
            params,
        )
        row = res.first()
        if row is None:
            return None
        await AuditWriter(session).write(
            AuditEvent(
                action="skill.update",
                target_type="skill",
                actor_type="user",
                actor_id=actor_id,
                target_id=skill_id,
            )
        )
        await session.commit()
    return _to_response(row)


async def delete_skill(*, actor_id: str, skill_id: str) -> bool:
    async with _service_session_factory()() as session:
        res = await session.execute(
            text("delete from public.skills where id = cast(:id as uuid) returning id"),
            {"id": skill_id},
        )
        if res.scalar_one_or_none() is None:
            return False
        await AuditWriter(session).write(
            AuditEvent(
                action="skill.delete",
                target_type="skill",
                actor_type="user",
                actor_id=actor_id,
                target_id=skill_id,
            )
        )
        await session.commit()
    return True


async def attach_skill(*, actor_id: str, skill_id: str, data: SkillAttachRequest) -> bool:
    """AI 社員の attached_skills に skill_id を追加 / 解除する。"""
    if data.attached:
        sql = (
            "update public.ai_employees set "
            "attached_skills = (select array(select distinct unnest("
            "attached_skills || array[cast(:s as uuid)]))), updated_at = now() "
            "where id = cast(:e as uuid) returning id"
        )
    else:
        sql = (
            "update public.ai_employees set "
            "attached_skills = array_remove(attached_skills, cast(:s as uuid)), "
            "updated_at = now() where id = cast(:e as uuid) returning id"
        )
    async with _service_session_factory()() as session:
        res = await session.execute(text(sql), {"s": skill_id, "e": data.ai_employee_id})
        if res.scalar_one_or_none() is None:
            return False
        await AuditWriter(session).write(
            AuditEvent(
                action="skill.attach" if data.attached else "skill.detach",
                target_type="ai_employee",
                actor_type="user",
                actor_id=actor_id,
                target_id=data.ai_employee_id,
                after={"skill_id": skill_id},
            )
        )
        await session.commit()
    return True


async def list_skills(
    session: AsyncSession, *, active_only: bool = True, limit: int = 100
) -> list[SkillLiteResponse]:
    """認証ユーザー向けスキルカタログ一覧 (RLS セッション / skills_select_all)。

    content_md 等の重量級カラムは返さない (S-C01/S-C02 の表示用)。
    """
    where = "where is_active" if active_only else ""
    res = await session.execute(
        text(
            "select id, name, version, description, is_active "
            f"from public.skills {where} order by name limit :limit"
        ),
        {"limit": limit},
    )
    return [
        SkillLiteResponse(
            id=str(r.id),
            name=r.name,
            version=r.version,
            description=r.description,
            is_active=r.is_active,
        )
        for r in res
    ]
