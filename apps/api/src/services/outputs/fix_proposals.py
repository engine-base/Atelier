# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
"""コメント起点の AI 修正提案 (GAP-023 — モック S-G01 の ai-fix ブロックの実体)。

フロー (モック準拠):
  1. 成果物コメントに対し「スティーブに修正提案を依頼」
     → LLM が文書 + コメントを読み、具体的な修正提案文を生成 (pending)
  2. 承認 → 提案を修正指示として revise (新バージョン生成) + approved
     却下 → rejected (文書は不変)

自動生成はしない — 提案の生成・適用は必ず人間の明示操作を起点にする
(S-E01 tool 承認ゲートと同じ「無承認自動実行の廃止」原則)。
ANTHROPIC_API_KEY 未設定は 503 (偽の提案を出さない)。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.outputs import FixProposalResponse, OutputResponse

from . import get_output, is_uuid
from .revise import (
    REVISE_MODEL,
    CompletionClient,
    OutputReviseError,
    load_source_html,
    revise_output,
)

_PROPOSE_SYSTEM = (
    "あなたは開発案件管理 SaaS のドキュメント AI「スティーブ」です。"
    "成果物ドキュメントへのコメント (修正要望) を読み、ドキュメントへの具体的な"
    "修正提案を 1〜3 文の日本語で作成してください。何をどこにどう変えるかを明示し、"
    "末尾は「承認しますか？」等の問いかけを付けないこと。提案本文のみを出力すること。"
)

_MAX_DOC_CONTEXT = 20_000

_COLS = "id, comment_id, output_id, proposal, status, applied_output_id, created_at, resolved_at"


def _row(row: Any) -> FixProposalResponse:
    return FixProposalResponse(
        id=str(row.id),
        comment_id=str(row.comment_id),
        output_id=str(row.output_id),
        proposal=str(row.proposal),
        status=str(row.status),
        applied_output_id=(None if row.applied_output_id is None else str(row.applied_output_id)),
        created_at=row.created_at,
        resolved_at=row.resolved_at,
    )


async def list_for_output(session: AsyncSession, output_id: str) -> list[FixProposalResponse]:
    res = await session.execute(
        text(
            f"select {_COLS} from public.output_fix_proposals "
            "where output_id = cast(:oid as uuid) order by created_at asc"
        ),
        {"oid": output_id},
    )
    return [_row(r) for r in res.all()]


async def _generate_proposal(
    doc_html: str,
    comment_content: str,
    client: CompletionClient | None,
    *,
    actor_id: str = "",
) -> tuple[str, str]:
    """提案文を生成する。返り値 (提案文, 使用経路)。

    GAP-171: 運営の ANTHROPIC_API_KEY 直叩きをやめ、費用順チェーン
    (relay = 本人の Claude サブスク → agent_sdk → API キー → fake) に統一。
    """
    from src.services.chat_sse.llm_chain import LLMUnavailable, llm_complete_or_injected

    def _fake() -> str:
        return (
            f"[fake LLM] コメント「{comment_content[:120]}」への対応として、"
            "該当箇所に説明サブセクションを追記します。"
        )

    try:
        out, provider = await llm_complete_or_injected(
            system_prompt=_PROPOSE_SYSTEM,
            user_text=(
                f"コメント (修正要望):\n{comment_content}\n\n"
                f"成果物ドキュメント (HTML 抜粋):\n{doc_html[:_MAX_DOC_CONTEXT]}"
            ),
            actor_id=actor_id,
            max_tokens=1024,
            fake=_fake,
            client=client,
            model=REVISE_MODEL,
        )
    except LLMUnavailable as exc:
        if exc.code in ("bridge_offline", "unconfigured"):
            raise OutputReviseError(
                "bridge_offline" if exc.code == "bridge_offline" else "llm_unconfigured",
                exc.message,
            ) from exc
        raise OutputReviseError("llm_failed", exc.message) from exc
    proposal = out.strip()
    if not proposal:
        raise OutputReviseError("llm_failed", "LLM が空の提案を返しました")
    return proposal, (REVISE_MODEL if provider == "injected" else provider)


async def propose(
    session: AsyncSession,
    *,
    actor_id: str,
    comment_id: str,
    client: CompletionClient | None = None,
) -> FixProposalResponse | None:
    """コメントへの修正提案を生成する。

    返り値 None = コメント不可視/不在/成果物コメントでない。
    ValueError = 既に pending 提案がある (409)。
    """
    if not is_uuid(comment_id):
        return None
    res = await session.execute(
        text(
            "select id, target_id, content from public.comments "
            "where id = cast(:cid as uuid) and target_type = 'workflow_output' "
            "and deleted_at is null"
        ),
        {"cid": comment_id},
    )
    comment = res.first()
    if comment is None:
        return None
    output = await get_output(session, str(comment.target_id))
    if output is None:
        return None

    dup = await session.execute(
        text(
            "select count(*) from public.output_fix_proposals "
            "where comment_id = cast(:cid as uuid) and status = 'pending'"
        ),
        {"cid": comment_id},
    )
    if int(dup.scalar_one()) > 0:
        raise ValueError("a pending fix proposal already exists for this comment")

    doc_html = "" if output.html_path is None else await load_source_html(output.html_path)
    proposal_text, _model = await _generate_proposal(
        doc_html, str(comment.content), client, actor_id=actor_id
    )

    row = await session.execute(
        text(
            "insert into public.output_fix_proposals (comment_id, output_id, proposal) "
            f"values (cast(:cid as uuid), cast(:oid as uuid), :p) returning {_COLS}"
        ),
        {"cid": comment_id, "oid": output.id, "p": proposal_text},
    )
    created = _row(row.one())
    await AuditWriter(session).write(
        AuditEvent(
            action="output.fix_proposal.propose",
            target_type="workflow_output",
            actor_type="user",
            actor_id=actor_id,
            target_id=output.id,
            after={"proposal_id": created.id, "comment_id": comment_id},
        )
    )
    return created


async def _get_pending(session: AsyncSession, proposal_id: str) -> FixProposalResponse | None:
    if not is_uuid(proposal_id):
        return None
    res = await session.execute(
        text(f"select {_COLS} from public.output_fix_proposals where id = cast(:id as uuid)"),
        {"id": proposal_id},
    )
    row = res.first()
    return None if row is None else _row(row)


async def approve(
    session: AsyncSession,
    *,
    actor_id: str,
    proposal_id: str,
    client: CompletionClient | None = None,
) -> tuple[FixProposalResponse, OutputResponse] | None:
    """承認 = 提案を修正指示として revise 実行 → 新バージョン + approved。

    返り値 None = 提案不可視/不在。ValueError = pending でない (409 二重解決防止)。
    """
    prop = await _get_pending(session, proposal_id)
    if prop is None:
        return None
    if prop.status != "pending":
        raise ValueError(f"proposal already {prop.status}")

    new_output = await revise_output(
        session,
        actor_id=actor_id,
        output_id=prop.output_id,
        instruction=prop.proposal,
        client=client,
        audit_action="output.fix_proposal.approve",
    )
    if new_output is None:
        return None

    row = await session.execute(
        text(
            "update public.output_fix_proposals "
            "set status = 'approved', applied_output_id = cast(:aid as uuid), "
            "resolved_at = now(), updated_at = now() "
            f"where id = cast(:id as uuid) and status = 'pending' returning {_COLS}"
        ),
        {"aid": new_output.id, "id": proposal_id},
    )
    updated = row.first()
    if updated is None:
        raise ValueError("proposal already resolved")
    return _row(updated), new_output


async def reject(
    session: AsyncSession, *, actor_id: str, proposal_id: str
) -> FixProposalResponse | None:
    """却下 = rejected (文書は不変)。ValueError = pending でない。"""
    prop = await _get_pending(session, proposal_id)
    if prop is None:
        return None
    if prop.status != "pending":
        raise ValueError(f"proposal already {prop.status}")
    row = await session.execute(
        text(
            "update public.output_fix_proposals "
            "set status = 'rejected', resolved_at = now(), updated_at = now() "
            f"where id = cast(:id as uuid) and status = 'pending' returning {_COLS}"
        ),
        {"id": proposal_id},
    )
    updated = row.first()
    if updated is None:
        raise ValueError("proposal already resolved")
    result = _row(updated)
    await AuditWriter(session).write(
        AuditEvent(
            action="output.fix_proposal.reject",
            target_type="workflow_output",
            actor_type="user",
            actor_id=actor_id,
            target_id=result.output_id,
            after={"proposal_id": proposal_id},
        )
    )
    return result
