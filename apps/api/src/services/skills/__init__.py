"""スキル管理 サービス層 (T-A-49 / F-007)。

E-009 skills の write（create/update/delete）+ AI 社員への装着。
skills は RLS で write 禁止 (skills_no_insert/update/delete) のため、
**service_role 相当のセッション (RLS バイパス)** で書き込む。呼出元 (route) で
is_admin gate 済を前提とし、全 write を audit_logs に記録する。
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.audit import AuditEvent, AuditWriter
from src.db.session import shared_session_factory
from src.schemas.admin import AdminSkillResponse
from src.schemas.skills import (
    SkillAttachRequest,
    SkillCreate,
    SkillLiteResponse,
    SkillReimportResponse,
    SkillUpdate,
)

_COLS = (
    "id, name, version, description, content_md, assets_storage_path, "
    "allowed_employee_roles, allowed_employee_ids, is_active, created_at, updated_at"
)


def _service_session_factory() -> async_sessionmaker[AsyncSession]:
    """GAP-197: engine はプロセスに 1 つ。

    以前は event loop ごとに engine を作ってキャッシュしていたが、engine を
    共有にしたのでこの層は不要になった (loop id は再利用されうるので、
    残しておくと死んだ engine を掴み続ける危険がある)。
    """
    return shared_session_factory()


def service_session_factory() -> async_sessionmaker[AsyncSession]:
    """service_role 相当セッション (GAP-144: content_md は列 revoke のため
    authenticated role では読めない — 内部読取はこの経路に限定する)。"""
    return _service_session_factory()


async def fetch_skills_md(skill_ids: list[str]) -> list[str]:
    """装着スキルの本文ブロック (`## スキル: name\\n content_md`) を返す。

    GAP-144: skills.content_md は authenticated から列 revoke 済のため、
    system prompt への注入用読取はここ (service 経路) に一本化する。
    ユーザー応答に content_md を直接返す用途で使ってはならない。
    """
    if not skill_ids:
        return []
    async with _service_session_factory()() as session:
        res = await session.execute(
            text(
                "select name, content_md from public.skills "
                "where id = any(cast(:ids as uuid[])) and is_active = true"
            ),
            {"ids": skill_ids},
        )
        return [f"## スキル: {r.name}\n{r.content_md!s}" for r in res.all()]


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
    """新規スキル登録。name+version 重複は 409 (500 に落とさない)。"""
    new_id = str(uuid.uuid4())
    async with _service_session_factory()() as session:
        try:
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
        except IntegrityError as exc:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "同じ名前・バージョンのスキルが既に存在します",
            ) from exc
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
    session: AsyncSession, *, active_only: bool = True, limit: int = 100, reveal: bool = False
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
            name=(r.name if reveal else None),
            version=(r.version if reveal else None),
            description=r.description,
            is_active=r.is_active,
        )
        for r in res
    ]


# --------------------------------------------------------------------------- #
# GAP-031④: ~/.claude/skills/ からのローカル一括再取込
# --------------------------------------------------------------------------- #
def parse_skill_md(raw: str) -> tuple[dict[str, str], str]:
    """SKILL.md の YAML frontmatter (--- ... ---) を素朴に解析する。

    (frontmatter の key→value, 本文) を返す。frontmatter が無ければ ({}, 全文)。
    値は同一行の "key: value" のみ対応 (ネスト・複数行は本文として扱わず無視) —
    name / description / version の取り出しに必要な最小限で、依存を増やさない。
    """
    if not raw.startswith("---"):
        return {}, raw
    lines = raw.split("\n")
    end = -1
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end < 0:
        return {}, raw
    meta: dict[str, str] = {}
    for line in lines[1:end]:
        if ":" not in line or line.startswith((" ", "\t", "#")):
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip().strip("'\"")
    return meta, "\n".join(lines[end + 1 :]).lstrip("\n")


def _skills_dir() -> Path:
    """再取込対象ディレクトリ (ATELIER_SKILLS_DIR、既定 ~/.claude/skills)。"""
    override = os.environ.get("ATELIER_SKILLS_DIR")
    return Path(override) if override else Path.home() / ".claude" / "skills"


async def reimport_local_skills(*, actor_id: str) -> SkillReimportResponse:
    """ローカルの <dir>/<skill>/SKILL.md を一括で upsert する (GAP-031④)。

    name をキーに: 未登録 → 追加 / content_md か description が変わっていれば
    更新 / 同一なら skip。DB 側の is_active・装着設定・version は上書きしない
    (運営が画面で行った運用設定を再取込で壊さない)。summary を audit に記録。
    """
    base = _skills_dir()
    if not base.is_dir():
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"スキルディレクトリが見つかりません: {base}",
        )
    entries: list[tuple[str, str | None, str]] = []  # (name, description, content_md)
    for child in sorted(base.iterdir()):
        skill_md = child / "SKILL.md"
        if not child.is_dir() or not skill_md.is_file():
            continue
        try:
            raw = skill_md.read_text(encoding="utf-8")
        except OSError:
            continue
        meta, _body = parse_skill_md(raw)
        name = meta.get("name") or child.name
        entries.append((name, meta.get("description") or None, raw))

    imported = 0
    updated = 0
    skipped = 0
    async with _service_session_factory()() as session:
        for name, description, content_md in entries:
            res = await session.execute(
                text("select id, description, content_md from public.skills where name = :nm"),
                {"nm": name},
            )
            row = res.first()
            if row is None:
                await session.execute(
                    text(
                        "insert into public.skills "
                        "(name, version, description, content_md) "
                        "values (:nm, '1.0.0', :desc, :cm)"
                    ),
                    {"nm": name, "desc": description, "cm": content_md},
                )
                imported += 1
            elif (
                str(row.content_md) != content_md
                or (None if row.description is None else str(row.description)) != description
            ):
                await session.execute(
                    text(
                        "update public.skills set content_md = :cm, description = :desc, "
                        "updated_at = now() where id = :id"
                    ),
                    {"cm": content_md, "desc": description, "id": row.id},
                )
                updated += 1
            else:
                skipped += 1
        await AuditWriter(session).write(
            AuditEvent(
                action="skill.reimport",
                target_type="skill",
                actor_type="user",
                actor_id=actor_id,
                target_id=None,
                after={
                    "dir": str(base),
                    "imported": imported,
                    "updated": updated,
                    "skipped": skipped,
                },
            )
        )
        await session.commit()
    return SkillReimportResponse(
        dir=str(base),
        total=len(entries),
        imported=imported,
        updated=updated,
        skipped=skipped,
    )
