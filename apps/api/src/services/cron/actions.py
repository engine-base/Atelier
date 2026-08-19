"""GAP-179: 自動実行 (cron_schedules.target_action) の実体と、その公開メタ情報。

**これまでの実態**: 画面で選べる 6 種類の自動実行のうち、実際に何かをするのは
`daily_digest` だけだった。`task_replay` / `knowledge_organize` /
`industry_extract` / `report_summary` は保存されるだけで永久に発火せず、
`weekly_burndown` は logger 出力のみの skeleton だった。画面には
「BYOK API 使用」というコスト表示まで出ていたが、そもそも実行されていない。

本モジュールは **1 つの信頼源** として次を持つ:
  - 各アクションが何をするか (title / description)
  - 実行に本人の PC (Bridge) が要るか (requires_bridge)
  - 誰の費用で動くか (cost_label / cost_note)
  - 実際に走る処理 (run)

画面のコスト表示もこの定義を API 経由で読む。「画面の説明」と「実際に走る処理」が
二度と食い違わないようにするため。
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal, cast

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter

from .output import (
    find_or_create_thread,
    post_assistant_message,
    project_owner_actor_id,
    project_workspace_id,
)

logger = logging.getLogger(__name__)

ActionStatus = Literal["done", "deferred"]
ActionGroup = Literal["impl", "knowledge", "notify"]

#: 本人サブスク経路 (Bridge) が使えないときの LLMUnavailable code。
#: 「今は無理だが後でやれば成功しうる」= 次のチェックで再試行する。
#: GAP-184: プラン枠の上限 (rate_limited) も必ずリセットされるのでここに含める。
#: 失敗として確定させると、上限に当たった日の自動実行が永久に欠ける。
RETRYABLE_LLM_CODES = frozenset({"bridge_offline", "llm_unconfigured", "rate_limited"})

COST_SUBSCRIPTION = "本人の Claude プラン枠"
COST_FREE = "コスト無料"

#: 1 回の自動実行で扱う件数の上限 (無人実行が暴走しないように)。
_ORGANIZE_LIMIT = 10
_REPLAY_LIMIT = 5
_PATTERN_LIMIT = 5


@dataclass(frozen=True)
class ActionOutcome:
    """1 回の実行結果。

    done      = 実行した (何もすることが無かった場合も含む — それは正常)
    deferred  = 今は実行できないので次のチェックで再試行する (理由は reason)
    """

    status: ActionStatus
    detail: dict[str, str] = field(default_factory=dict[str, str])
    reason: str | None = None


Runner = Callable[..., Awaitable[ActionOutcome]]


@dataclass(frozen=True)
class CronActionSpec:
    action: str
    title: str
    description: str
    group: ActionGroup
    staff: str
    requires_bridge: bool
    cost_label: str
    cost_note: str
    run: Runner


# --------------------------------------------------------------------------- #
# 共通ヘルパー
# --------------------------------------------------------------------------- #


def _strip_fence(raw: str) -> str:
    body = raw.strip()
    fence = re.match(r"^```[a-zA-Z]*\n(.*)\n```$", body, flags=re.DOTALL)
    return fence.group(1).strip() if fence else body


async def _complete_via_owner(
    session: AsyncSession,
    *,
    project_id: str,
    system_prompt: str,
    user_text: str,
    max_tokens: int,
    complete: Any = None,
) -> tuple[str | None, ActionOutcome | None]:
    """workspace owner の本人サブスク経路で LLM を 1 回呼ぶ。

    返り値は (本文, None) か (None, deferred な ActionOutcome)。
    無人実行なので例外は投げず、再試行可能な理由として返す。
    """
    actor_id = await project_owner_actor_id(session, project_id=project_id)
    if actor_id is None:
        return None, ActionOutcome(status="deferred", reason="no_owner")

    if complete is None:
        from src.services.chat_sse.llm_chain import llm_complete as _complete

        complete = _complete
    from src.services.chat_sse.llm_chain import LLMUnavailable

    try:
        body, _provider = await complete(
            system_prompt=system_prompt,
            user_text=user_text,
            actor_id=actor_id,
            max_tokens=max_tokens,
        )
    except LLMUnavailable as exc:
        if exc.code in RETRYABLE_LLM_CODES:
            return None, ActionOutcome(status="deferred", reason=exc.code)
        raise
    return str(body), None


# --------------------------------------------------------------------------- #
# 実体 1: 日次ダイジェスト (決定論 / 費用ゼロ)
# --------------------------------------------------------------------------- #


async def _run_daily_digest(
    session: AsyncSession, *, project_id: str, **_kwargs: Any
) -> ActionOutcome:
    from .digest import run_project_digest

    result = await run_project_digest(session, project_id=project_id)
    return ActionOutcome(
        status="done",
        detail={"generated": str(result["generated"])},
        reason=result.get("reason"),
    )


# --------------------------------------------------------------------------- #
# 実体 2: 週次バーンダウン (決定論 / 費用ゼロ)
# --------------------------------------------------------------------------- #


async def _run_weekly_burndown(
    session: AsyncSession, *, project_id: str, **_kwargs: Any
) -> ActionOutcome:
    from .burndown import run_project_burndown

    result = await run_project_burndown(session, project_id=project_id)
    return ActionOutcome(
        status="done",
        detail={"generated": str(result["generated"])},
        reason=result.get("reason"),
    )


# --------------------------------------------------------------------------- #
# 実体 3: タスク自動再生 (サーバは投入のみ / 実行は本人の PC)
# --------------------------------------------------------------------------- #


async def _run_task_replay(
    session: AsyncSession, *, project_id: str, **_kwargs: Any
) -> ActionOutcome:
    """着手可 (ready) のタスクを dispatcher キューへ投入する。

    実際にコードを書くのは **利用者の PC の Claude Code (Bridge)**。ここでは
    キューに積むだけなので、PC が落ちていても投入は成功し、PC を起動した時点で
    Bridge が拾って実行する (＝ deferred にしない)。
    """
    from src.schemas.tasks import PlayTaskRequest
    from src.services.tasks import PlayResult, play_task

    actor_id = await project_owner_actor_id(session, project_id=project_id)
    if actor_id is None:
        return ActionOutcome(status="deferred", reason="no_owner")

    rows = (
        await session.execute(
            text(
                "select id from public.tasks "
                "where project_id = cast(:p as uuid) and deleted_at is null "
                "and lifecycle_stage = 'ready' "
                "order by created_at limit :lim"
            ),
            {"p": project_id, "lim": _REPLAY_LIMIT},
        )
    ).all()

    queued = 0
    blocked = 0
    for row in rows:
        result, _resp = await play_task(
            session,
            actor_id=actor_id,
            task_id=str(row.id),
            data=PlayTaskRequest(),
        )
        if result is PlayResult.SUCCESS:
            queued += 1
        else:
            blocked += 1
    return ActionOutcome(
        status="done",
        detail={"queued": str(queued), "not_started": str(blocked)},
    )


# --------------------------------------------------------------------------- #
# 実体 4: 業界パターン抽出 (決定論 / 費用ゼロ → 承認待ちへ提案)
# --------------------------------------------------------------------------- #


async def _run_industry_extract(
    session: AsyncSession, *, project_id: str, **_kwargs: Any
) -> ActionOutcome:
    """複数ナレッジに共通する tag 組合せを検出し、承認待ち候補として提案する。

    自動でナレッジには入れない (GAP-167 の方針: 人が採用して初めてナレッジ)。
    """
    from src.services.knowledge import extract_patterns

    workspace_id = await project_workspace_id(session, project_id=project_id)
    if workspace_id is None:
        return ActionOutcome(status="done", detail={"proposed": "0"}, reason="project_missing")

    patterns = await extract_patterns(
        session,
        account_id=workspace_id,
        category=None,
        min_occurrences=2,
        limit=_PATTERN_LIMIT,
    )
    proposed = 0
    for pattern in patterns.patterns:
        title = f"共通パターン: {' / '.join(pattern.pattern_tags)}"
        body = (
            f"{pattern.occurrence_count} 件のナレッジが同じタグ構成"
            f" ({', '.join(pattern.pattern_tags)}) を持っています。\n"
            f"平均確度 {pattern.avg_confidence:.2f}。共通ナレッジへの昇格を検討してください。\n\n"
            "代表ナレッジ:\n" + "\n".join(f"- {kid}" for kid in pattern.representative_ids)
        )
        row = (
            await session.execute(
                text(
                    "insert into public.knowledge_candidates "
                    "(workspace_id, project_id, title, content_md, category, tags) "
                    "values (cast(:w as uuid), cast(:p as uuid), :title, :body, :cat, :tags) "
                    "on conflict (workspace_id, title) do nothing returning id"
                ),
                {
                    "w": workspace_id,
                    "p": project_id,
                    "title": title,
                    "body": body,
                    "cat": "業界パターン",
                    "tags": list(pattern.pattern_tags),
                },
            )
        ).first()
        if row is not None:
            proposed += 1
    return ActionOutcome(status="done", detail={"proposed": str(proposed)})


# --------------------------------------------------------------------------- #
# 実体 5: ナレッジ整理 (本人サブスク経路 — PC 接続が必要)
# --------------------------------------------------------------------------- #

_ORGANIZE_SYSTEM = """あなたはナレッジ整理の担当者です。
渡されたナレッジ 1 件ごとに、適切なカテゴリと 1〜4 個のタグを付けてください。
出力は JSON 配列のみ。説明文やコードフェンスは書かないでください。
形式: [{"id": "<渡された id>", "category": "<日本語のカテゴリ>", "tags": ["タグ1", "タグ2"]}]
カテゴリは「ノウハウ」「設計」「営業」「運用」「技術」から最も近いものを選びます。"""


async def _run_knowledge_organize(
    session: AsyncSession, *, project_id: str, complete: Any = None, **_kwargs: Any
) -> ActionOutcome:
    """タグ/カテゴリが未整備のナレッジに分類とタグを付ける。"""
    rows = (
        await session.execute(
            text(
                "select id, title, content_md from public.knowledge_nodes "
                "where source_project_id = cast(:p as uuid) and deleted_at is null "
                "and (cardinality(tags) = 0 or category = '' or category = '未分類') "
                "order by created_at limit :lim"
            ),
            {"p": project_id, "lim": _ORGANIZE_LIMIT},
        )
    ).all()
    if not rows:
        # 整理対象が無いときは LLM を呼ばない (利用者のプラン枠を無駄に使わない)
        return ActionOutcome(status="done", detail={"organized": "0"}, reason="nothing_to_organize")

    listing = "\n\n".join(
        f"id: {r.id}\nタイトル: {r.title}\n本文: {str(r.content_md)[:600]}" for r in rows
    )
    body, deferred = await _complete_via_owner(
        session,
        project_id=project_id,
        system_prompt=_ORGANIZE_SYSTEM,
        user_text=listing,
        max_tokens=1200,
        complete=complete,
    )
    if deferred is not None:
        return deferred

    try:
        parsed: Any = json.loads(_strip_fence(body or "[]"))
    except json.JSONDecodeError:
        logger.warning("knowledge_organize: LLM 応答が JSON ではない (project=%s)", project_id)
        return ActionOutcome(status="done", detail={"organized": "0"}, reason="unparsable_response")
    if not isinstance(parsed, list):
        return ActionOutcome(status="done", detail={"organized": "0"}, reason="unparsable_response")

    valid_ids = {str(r.id) for r in rows}
    organized = 0
    for raw_item in cast("list[object]", parsed):
        if not isinstance(raw_item, dict):
            continue
        item = cast("dict[str, object]", raw_item)
        node_id = str(item.get("id", ""))
        if node_id not in valid_ids:
            continue
        category = str(item.get("category") or "").strip()
        raw_tags = item.get("tags")
        tags = (
            [str(t).strip() for t in cast("list[object]", raw_tags) if str(t).strip()]
            if isinstance(raw_tags, list)
            else []
        )
        if not category and not tags:
            continue
        await session.execute(
            text(
                "update public.knowledge_nodes set "
                "category = coalesce(nullif(:cat, ''), category), "
                "tags = case when cardinality(cast(:tags as text[])) > 0 "
                "            then cast(:tags as text[]) else tags end, "
                "updated_at = now() "
                "where id = cast(:i as uuid)"
            ),
            {"i": node_id, "cat": category, "tags": tags},
        )
        organized += 1
    if organized:
        await AuditWriter(session).write(
            AuditEvent(
                action="cron.knowledge_organize.apply",
                target_type="knowledge_node",
                actor_type="system",
                actor_id="system",
                target_id=project_id,
                after={"organized": organized},
            )
        )
    return ActionOutcome(status="done", detail={"organized": str(organized)})


# --------------------------------------------------------------------------- #
# 実体 6: 進捗レポート要約 (本人サブスク経路 — PC 接続が必要)
# --------------------------------------------------------------------------- #

REPORT_THREAD_TITLE = "進捗レポート"

_REPORT_SYSTEM = """あなたはプロジェクトマネージャーです。
渡された数値だけを根拠に、関係者向けの進捗レポートを日本語 markdown で書いてください。
- 数値に無い事実を創作しないこと
- 「今週の状況」「気になる点」「次の一手」の 3 見出し
- 全体で 400 字以内"""


async def _run_report_summary(
    session: AsyncSession, *, project_id: str, complete: Any = None, **_kwargs: Any
) -> ActionOutcome:
    """DB の実数値を材料に、関係者向けレポートを本人サブスク経路で書いて投稿する。"""
    from .digest import build_project_digest

    facts = await build_project_digest(session, project_id=project_id)
    outputs = (
        await session.execute(
            text(
                "select stage, coalesce(nullif(meta->>'file_name', ''), summary, '') as label "
                "from public.workflow_outputs "
                "where project_id = cast(:p as uuid) and deleted_at is null "
                "order by created_at desc limit 5"
            ),
            {"p": project_id},
        )
    ).all()
    if outputs:
        facts += "\n\n## 直近の成果物\n" + "\n".join(
            f"- {r.stage}: {r.label}" if r.label else f"- {r.stage}" for r in outputs
        )

    body, deferred = await _complete_via_owner(
        session,
        project_id=project_id,
        system_prompt=_REPORT_SYSTEM,
        user_text=facts,
        max_tokens=900,
        complete=complete,
    )
    if deferred is not None:
        return deferred

    thread_id = await find_or_create_thread(
        session, project_id=project_id, title=REPORT_THREAD_TITLE
    )
    if thread_id is None:
        return ActionOutcome(status="deferred", reason="no_ai_employee")
    msg_id = await post_assistant_message(session, thread_id=thread_id, body=str(body))
    await AuditWriter(session).write(
        AuditEvent(
            action="cron.report_summary.generate",
            target_type="chat_message",
            actor_type="system",
            actor_id="system",
            target_id=msg_id,
            after={"project_id": project_id},
        )
    )
    return ActionOutcome(status="done", detail={"generated": "1"})


# --------------------------------------------------------------------------- #
# レジストリ (画面のコスト表示もここを読む)
# --------------------------------------------------------------------------- #

ACTION_SPECS: dict[str, CronActionSpec] = {
    "task_replay": CronActionSpec(
        action="task_replay",
        title="タスク自動再生",
        description=(
            "「着手可」のタスクを実行キューに投入します。実際にコードを書くのは"
            "あなたの PC の Claude Code なので、PC が落ちていても投入は行われ、"
            "起動した時点で順に実行されます。"
        ),
        group="impl",
        staff="ソー（実装）",
        requires_bridge=False,
        cost_label=COST_SUBSCRIPTION,
        cost_note="実行はあなたの PC / あなたの Claude プラン。API 課金は発生しません。",
        run=_run_task_replay,
    ),
    "knowledge_organize": CronActionSpec(
        action="knowledge_organize",
        title="ナレッジ整理",
        description=(
            "カテゴリやタグが未整備のナレッジに、分類とタグを付けます（1 回あたり最大 10 件）。"
        ),
        group="knowledge",
        staff="ティチャラ",
        requires_bridge=True,
        cost_label=COST_SUBSCRIPTION,
        cost_note="あなたの PC の Claude Code で実行します。PC が起動していない間は保留され、次回に回ります。",
        run=_run_knowledge_organize,
    ),
    "industry_extract": CronActionSpec(
        action="industry_extract",
        title="業界パターン抽出",
        description=(
            "複数のナレッジに共通するタグ構成を検出し、共通ナレッジへの昇格を"
            "「ナレッジ候補」として承認待ちに提案します。自動では取り込みません。"
        ),
        group="knowledge",
        staff="ティチャラ",
        requires_bridge=False,
        cost_label=COST_FREE,
        cost_note="サーバー側の集計のみ。AI も API も使いません。",
        run=_run_industry_extract,
    ),
    "report_summary": CronActionSpec(
        action="report_summary",
        title="進捗レポート配信",
        description=(
            "DB の実数値を材料に関係者向けの進捗レポートを作成し、"
            "「進捗レポート」スレッドへ投稿します。"
        ),
        group="notify",
        staff="スティーブ",
        requires_bridge=True,
        cost_label=COST_SUBSCRIPTION,
        cost_note="あなたの PC の Claude Code で実行します。PC が起動していない間は保留され、次回に回ります。",
        run=_run_report_summary,
    ),
    "daily_digest": CronActionSpec(
        action="daily_digest",
        title="日次ダイジェスト",
        description="その日のタスク状況・フェーズ・実行結果を集計して投稿します。",
        group="notify",
        staff="スティーブ",
        requires_bridge=False,
        cost_label=COST_FREE,
        cost_note="サーバー側の集計のみ。AI も API も使いません。",
        run=_run_daily_digest,
    ),
    "weekly_burndown": CronActionSpec(
        action="weekly_burndown",
        title="週次バーンダウン",
        description="残タスクと直近 7 日の消化ペースを集計し、完了見込みを出します。",
        group="notify",
        staff="バックエンドのみ",
        requires_bridge=False,
        cost_label=COST_FREE,
        cost_note="サーバー側の集計のみ。AI も API も使いません。",
        run=_run_weekly_burndown,
    ),
}


def get_action_spec(action: str) -> CronActionSpec | None:
    return ACTION_SPECS.get(action)


__all__ = [
    "ACTION_SPECS",
    "COST_FREE",
    "COST_SUBSCRIPTION",
    "RETRYABLE_LLM_CODES",
    "ActionOutcome",
    "CronActionSpec",
    "get_action_spec",
]
