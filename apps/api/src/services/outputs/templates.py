"""GAP-154: 出力テンプレート (workspace 単位・種類ごと自作・生成時必ず注入)。

経営者決定: テンプレは workspace のみ。「基本的にそれを使う」を構造で保証する —
チャット生成 (現在工程の成果物) とスティーブ改訂の system prompt に自動注入し、
AI 任せの気まぐれなフォーマットを排除する。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.outputs import OutputTemplateResponse

# 成果物の stage 体系 (workflow_stage_enum) に対する表示名。
# UI の種類セレクトと注入ブロックの見出しに使う。
STAGE_LABELS: dict[str, str] = {
    "hearing": "議事録・ヒアリングメモ",
    "proposal": "提案書",
    "estimate": "見積書",
    "contract": "契約書ドラフト",
    "nda": "NDA ドラフト",
    "invoice": "請求書",
    "requirements": "要件定義書",
    "architecture": "アーキ設計書",
    "design": "デザイン仕様書",
    "breakdown": "機能分解書",
    "tasks": "タスク一覧",
    "implementation": "実装ドキュメント",
    "verification": "テスト仕様書",
    "delivery": "納品書・完了報告",
}

_MAX_INJECT_CHARS = 4000

_COLS = "id, workspace_id, stage::text as stage, title, content_md, created_at, updated_at"


def _to_response(row: Any) -> OutputTemplateResponse:
    stage = str(row.stage)
    return OutputTemplateResponse(
        id=str(row.id),
        workspace_id=str(row.workspace_id),
        stage=stage,
        stage_label=STAGE_LABELS.get(stage, stage),
        title=str(row.title),
        content_md=str(row.content_md),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _workspace_visible(session: AsyncSession, workspace_id: str) -> bool:
    row = (
        await session.execute(
            text("select 1 from public.workspaces where id = cast(:w as uuid)"),
            {"w": workspace_id},
        )
    ).first()
    return row is not None


async def list_templates(
    session: AsyncSession, *, workspace_id: str
) -> list[OutputTemplateResponse] | None:
    """workspace のテンプレ一覧 (stage 順)。不可視 workspace は None。"""
    if not await _workspace_visible(session, workspace_id):
        return None
    rows = (
        await session.execute(
            text(
                f"select {_COLS} from public.output_templates "
                "where workspace_id = cast(:w as uuid) order by stage"
            ),
            {"w": workspace_id},
        )
    ).all()
    return [_to_response(r) for r in rows]


async def upsert_template(
    session: AsyncSession,
    *,
    actor_id: str,
    workspace_id: str,
    stage: str,
    title: str,
    content_md: str,
) -> OutputTemplateResponse | None:
    """テンプレ保存 (workspace × stage で upsert)。不可視 workspace は None。"""
    if stage not in STAGE_LABELS:
        raise ValueError(f"unknown template kind: {stage}")
    if not await _workspace_visible(session, workspace_id):
        return None
    row = (
        await session.execute(
            text(
                "insert into public.output_templates "
                "(workspace_id, stage, title, content_md, updated_by) "
                "values (cast(:w as uuid), cast(:s as workflow_stage_enum), :t, :c, "
                "        cast(:u as uuid)) "
                "on conflict (workspace_id, stage) do update set "
                "title = excluded.title, content_md = excluded.content_md, "
                "updated_by = excluded.updated_by, updated_at = now() "
                f"returning {_COLS}"
            ),
            {"w": workspace_id, "s": stage, "t": title[:120], "c": content_md, "u": actor_id},
        )
    ).one()
    await AuditWriter(session).write(
        AuditEvent(
            action="output_template.upsert",
            target_type="workspace",
            actor_type="user",
            actor_id=actor_id,
            target_id=workspace_id,
            after={"stage": stage, "chars": len(content_md)},
        )
    )
    return _to_response(row)


async def delete_template(
    session: AsyncSession, *, actor_id: str, workspace_id: str, stage: str
) -> bool:
    """テンプレ削除 (以後はテンプレ無しの生成に戻る)。False = 不在。"""
    res = await session.execute(
        text(
            "delete from public.output_templates "
            "where workspace_id = cast(:w as uuid) "
            "and stage = cast(:s as workflow_stage_enum) returning id"
        ),
        {"w": workspace_id, "s": stage},
    )
    if res.first() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="output_template.delete",
            target_type="workspace",
            actor_type="user",
            actor_id=actor_id,
            target_id=workspace_id,
            after={"stage": stage},
        )
    )
    return True


async def template_for_stage(
    session: AsyncSession, *, project_id: str, stage: str
) -> tuple[str, str] | None:
    """project の workspace の該当 stage テンプレ (title, content_md)。無ければ None。"""
    row = (
        await session.execute(
            text(
                "select ot.title, ot.content_md from public.output_templates ot "
                "join public.projects p on p.workspace_id = ot.workspace_id "
                "where p.id = cast(:p as uuid) "
                "and ot.stage = cast(:s as workflow_stage_enum)"
            ),
            {"p": project_id, "s": stage},
        )
    ).first()
    return None if row is None else (str(row.title), str(row.content_md))


def render_template_block(*, stage: str, title: str, content_md: str) -> str:
    """system prompt へ注入するテンプレブロック (上限あり — 実測で切る)。"""
    label = STAGE_LABELS.get(stage, stage)
    body = content_md[:_MAX_INJECT_CHARS]
    return (
        f"# 出力テンプレート: {label}"
        + (f"（{title}）" if title else "")
        + "\nこのワークスペースで定めた型。該当する成果物 (文書) を作成・改訂するときは"
        "必ずこの構成・項目・書式に従うこと。テンプレに無い独自構成へ勝手に"
        "変えないこと。\n---\n" + body
    )


async def templates_context_block(session: AsyncSession, *, project_id: str) -> str:
    """チャット注入用: 現在工程 (active フェーズの current stage) のテンプレ。

    現在工程の成果物を作る場面で「基本的にそれを使う」を保証する。
    テンプレ未設定・工程未初期化なら空文字。
    """
    row = (
        await session.execute(
            text(
                "select fs.stage_key from public.project_flow_stages fs "
                "join public.delivery_phases dp on dp.id = fs.delivery_phase_id "
                "where fs.project_id = cast(:p as uuid) and dp.status = 'active' "
                "and fs.status = 'pending' order by fs.seq limit 1"
            ),
            {"p": project_id},
        )
    ).first()
    if row is None:
        return ""
    found = await template_for_stage(session, project_id=project_id, stage=str(row.stage_key))
    if found is None:
        return ""
    title, content = found
    return render_template_block(stage=str(row.stage_key), title=title, content_md=content)
