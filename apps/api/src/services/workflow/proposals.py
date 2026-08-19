# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
"""S-F02 AI 提案フェーズ = COO AI (ジャービス) による次フェーズ提案 (GAP-022)。

運用ルール「フェーズ追加は AI 提案のみ」の実体。GAP-023/024 と同じ確定アーキの
判断 (自然言語 → AI が生成、生成は人間の明示操作起点・自動生成しない) に従う:
  1. 「ジャービスに次フェーズを提案してもらう」(明示操作) → LLM がプロジェクトの
     既存フェーズ・タスク状況を読み、次フェーズ (name/description/reason) を提案
  2. 承認 → 実 phases 行を確定 (approved_phase_id) / 却下 → rejected (不変)
GAP-171/175: 実行は本人の Claude サブスク (Bridge)。経路なしは 503 (偽の提案を出さない)。テストのみ
ATELIER_ALLOW_FAKE_LLM=1 で決定的スタブ。1 プロジェクトにつき pending は 1 件。
"""

from __future__ import annotations

import json
import os
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.workflow import PhaseProposalResponse, PhaseResponse

from . import is_uuid
from . import phase_row_to_response as _phase_row_to_response

PROPOSE_MODEL = os.environ.get("ATELIER_COO_MODEL", "claude-sonnet-4-6")

_SYSTEM = (
    "あなたは開発案件管理 SaaS の COO AI「ジャービス」です。"
    "プロジェクトの既存フェーズ一覧とタスク状況を読み、次に確定すべきフェーズを"
    " 1 つ提案してください。出力は次のキーを持つ JSON オブジェクトのみ: "
    '{"name": "フェーズ名 (50 字以内)", "description": "内容の要約 (120 字以内)", '
    '"reason": "この順序で提案する理由 (300 字以内)"}。'
    "説明・コードフェンス・前置きを一切出力しないこと。"
)


class PhaseProposalError(Exception):
    """提案生成の構造的失敗 (code: llm_unconfigured / llm_failed)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


_COLS = (
    "id, project_id, name, description, reason, proposed_order, proposed_by, "
    "status, approved_phase_id, created_at, resolved_at"
)


def _row(row: Any) -> PhaseProposalResponse:
    return PhaseProposalResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        name=str(row.name),
        description=(None if row.description is None else str(row.description)),
        reason=str(row.reason),
        proposed_order=int(row.proposed_order),
        proposed_by=str(row.proposed_by),
        status=str(row.status),
        approved_phase_id=(None if row.approved_phase_id is None else str(row.approved_phase_id)),
        created_at=row.created_at,
        resolved_at=row.resolved_at,
    )


def _strip_fence(t: str) -> str:
    t = t.strip()
    if t.startswith("```"):
        nl = t.find("\n")
        if nl >= 0:
            t = t[nl + 1 :]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


async def _generate(
    project_name: str,
    phases_summary: str,
    client: Any | None,
    *,
    actor_id: str = "",
) -> tuple[str, str | None, str, str]:
    """提案を生成する。返り値 (name, description, reason, 使用経路)。

    GAP-171: 運営の ANTHROPIC_API_KEY 直叩きをやめ、費用順チェーン
    (relay = 本人の Claude サブスク → agent_sdk → API キー → fake) に統一。
    """
    from src.services.chat_sse.llm_chain import LLMUnavailable, llm_complete_or_injected

    def _fake() -> str:
        return json.dumps(
            {
                "name": "次フェーズ提案（検証強化）",
                "description": "[fake LLM] 既存フェーズの完了状況を踏まえた次工程",
                "reason": (
                    f"[fake LLM] 既存フェーズ構成（{phases_summary[:120]}）を踏まえ、"
                    "次に確定すべき工程として提案します。"
                ),
            },
            ensure_ascii=False,
        )

    try:
        out, provider = await llm_complete_or_injected(
            system_prompt=_SYSTEM,
            user_text=(
                f"プロジェクト名: {project_name}\n\n既存フェーズとタスク状況:\n{phases_summary}"
            ),
            actor_id=actor_id,
            max_tokens=1024,
            fake=_fake,
            client=client,
            model=PROPOSE_MODEL,
            temperature=0.3,
        )
    except LLMUnavailable as exc:
        if exc.code in ("bridge_offline", "unconfigured"):
            raise PhaseProposalError(
                "bridge_offline" if exc.code == "bridge_offline" else "llm_unconfigured",
                exc.message,
            ) from exc
        raise PhaseProposalError("llm_failed", exc.message) from exc
    try:
        parsed = json.loads(_strip_fence(out))
        name = str(parsed["name"]).strip()[:200]
        reason = str(parsed["reason"]).strip()
        description = str(parsed.get("description") or "").strip() or None
    except (ValueError, KeyError, TypeError) as e:
        raise PhaseProposalError("llm_failed", f"LLM 応答の JSON 解析に失敗: {e}") from e
    if not name or not reason:
        raise PhaseProposalError("llm_failed", "LLM が空の提案を返しました")
    return name, description, reason, (PROPOSE_MODEL if provider == "injected" else provider)


async def propose(
    session: AsyncSession,
    *,
    actor_id: str,
    project_id: str,
    client: Any | None = None,
) -> PhaseProposalResponse | None:
    """次フェーズ提案を生成する。None = project 不可視/不在。ValueError = pending 重複。"""
    if not is_uuid(project_id):
        return None
    proj = await session.execute(
        text(
            "select id, name from public.projects where id = cast(:pid as uuid) and deleted_at is null"
        ),
        {"pid": project_id},
    )
    project = proj.first()
    if project is None:
        return None

    dup = await session.execute(
        text(
            "select count(*) from public.phase_proposals "
            "where project_id = cast(:pid as uuid) and status = 'pending'"
        ),
        {"pid": project_id},
    )
    if int(dup.scalar_one()) > 0:
        raise ValueError("a pending phase proposal already exists for this project")

    phases = await session.execute(
        text(
            'select p."order", p.name, p.status, '
            "(select count(*) from public.tasks t where t.phase_id = p.id and t.deleted_at is null) as task_count "
            "from public.phases p where p.project_id = cast(:pid as uuid) "
            'order by p."order"'
        ),
        {"pid": project_id},
    )
    rows = phases.all()
    summary = (
        "\n".join(
            f"- 第 {r.order} 段階 {r.name} ({r.status}, タスク {r.task_count} 件)" for r in rows
        )
        or "(フェーズ未作成)"
    )
    next_order = max((int(r.order) for r in rows), default=0) + 1

    name, description, reason, model = await _generate(
        str(project.name), summary, client, actor_id=actor_id
    )

    row = await session.execute(
        text(
            "insert into public.phase_proposals "
            "(project_id, name, description, reason, proposed_order, model) "
            "values (cast(:pid as uuid), :n, :d, :r, :o, :m) "
            f"returning {_COLS}"
        ),
        {"pid": project_id, "n": name, "d": description, "r": reason, "o": next_order, "m": model},
    )
    created = _row(row.one())
    await AuditWriter(session).write(
        AuditEvent(
            action="phase.proposal.propose",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
            after={"proposal_id": created.id, "name": name},
        )
    )
    return created


async def list_for_project(session: AsyncSession, project_id: str) -> list[PhaseProposalResponse]:
    res = await session.execute(
        text(
            f"select {_COLS} from public.phase_proposals "
            "where project_id = cast(:pid as uuid) order by created_at desc limit 20"
        ),
        {"pid": project_id},
    )
    return [_row(r) for r in res.all()]


async def _get(session: AsyncSession, proposal_id: str) -> PhaseProposalResponse | None:
    if not is_uuid(proposal_id):
        return None
    res = await session.execute(
        text(f"select {_COLS} from public.phase_proposals where id = cast(:id as uuid)"),
        {"id": proposal_id},
    )
    row = res.first()
    return None if row is None else _row(row)


async def approve(
    session: AsyncSession, *, actor_id: str, proposal_id: str
) -> tuple[PhaseProposalResponse, PhaseResponse] | None:
    """承認 = 実 phases 行を確定。None = 不可視/不在。ValueError = pending でない。"""
    prop = await _get(session, proposal_id)
    if prop is None:
        return None
    if prop.status != "pending":
        raise ValueError(f"proposal already {prop.status}")

    # 承認時点の実 order を再計算 (提案後にフェーズが増えていても衝突させない)
    phase_row = await session.execute(
        text(
            'insert into public.phases (project_id, "order", name, description) '
            "select cast(:pid as uuid), "
            'coalesce(max("order"), 0) + 1, :n, :d '
            "from public.phases where project_id = cast(:pid as uuid) "
            'returning id, project_id, "order", name, description, status, '
            "assigned_employee_ids, started_at, completed_at, created_at"
        ),
        {"pid": prop.project_id, "n": prop.name, "d": prop.description},
    )
    phase = _phase_row_to_response(phase_row.one())

    upd = await session.execute(
        text(
            "update public.phase_proposals "
            "set status = 'approved', approved_phase_id = cast(:phid as uuid), "
            "resolved_at = now(), updated_at = now() "
            f"where id = cast(:id as uuid) and status = 'pending' returning {_COLS}"
        ),
        {"phid": phase.id, "id": proposal_id},
    )
    updated = upd.first()
    if updated is None:
        raise ValueError("proposal already resolved")
    await AuditWriter(session).write(
        AuditEvent(
            action="phase.proposal.approve",
            target_type="phase",
            actor_type="user",
            actor_id=actor_id,
            target_id=phase.id,
            after={"proposal_id": proposal_id, "name": phase.name, "order": phase.order},
        )
    )
    return _row(updated), phase


async def reject(
    session: AsyncSession, *, actor_id: str, proposal_id: str
) -> PhaseProposalResponse | None:
    """却下 = rejected (フェーズは作られない)。ValueError = pending でない。"""
    prop = await _get(session, proposal_id)
    if prop is None:
        return None
    if prop.status != "pending":
        raise ValueError(f"proposal already {prop.status}")
    res = await session.execute(
        text(
            "update public.phase_proposals "
            "set status = 'rejected', resolved_at = now(), updated_at = now() "
            f"where id = cast(:id as uuid) and status = 'pending' returning {_COLS}"
        ),
        {"id": proposal_id},
    )
    row = res.first()
    if row is None:
        raise ValueError("proposal already resolved")
    result = _row(row)
    await AuditWriter(session).write(
        AuditEvent(
            action="phase.proposal.reject",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=result.project_id,
            after={"proposal_id": proposal_id},
        )
    )
    return result
