"""GAP-150: プロジェクトフロー (COO ハブ&スポーク / ステージゲート) サービス層。

経営者承認済み設計:
  - 案件は決まったフローで進むのが基本。COO (executive = ジャービス) が窓口で、
    現在ステージの担当部門の社員へ繋ぐ → 完了で COO に戻り次を案内する。
  - ソフトゲート既定: 順序外のステージは locked 表示だが、理由を持って
    越えられる (UI 側で警告)。ハードゲート (契約・納品) は confirm=true の
    明示確認なしに完了できず、スキップも不可。
  - スキップは skippable な工程のみ・理由必須 (黙って消さない)。

状態は pending / done / skipped の 3 値のみ。「現在のステージ」は
最小 seq の pending として導出する (遷移バグの余地を残さない)。
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.flow import FlowStageResponse, FlowStageTemplate

# ── フロー・テンプレート (プロジェクト種別ごと) ─────────────────────
#
# stage_key は workflow_outputs の stage 体系と揃える (成果物と自然に紐づく)。
# department は担当部門 — 実社員は workspace の該当部門から解決する。

_CLIENT_WORK: list[FlowStageTemplate] = [
    FlowStageTemplate(stage_key="hearing", title="商談・ヒアリング", department="product"),
    FlowStageTemplate(stage_key="proposal", title="提案", department="sales", skippable=True),
    FlowStageTemplate(stage_key="estimate", title="見積", department="sales", skippable=True),
    FlowStageTemplate(stage_key="contract", title="契約", department="sales", hard_gate=True),
    FlowStageTemplate(stage_key="requirements", title="要件定義", department="product"),
    FlowStageTemplate(
        stage_key="architecture",
        title="アーキ設計",
        department="architecture",
        skippable=True,
    ),
    FlowStageTemplate(stage_key="design", title="デザイン・モック", department="design"),
    FlowStageTemplate(stage_key="implementation", title="タスク分解・実装", department="dev_qa"),
    FlowStageTemplate(stage_key="verification", title="検証", department="dev_qa"),
    FlowStageTemplate(
        stage_key="delivery", title="納品・請求", department="executive", hard_gate=True
    ),
]

# 社内プロダクト/個人: 商流 (提案・見積・契約) を持たない
_INTERNAL: list[FlowStageTemplate] = [
    FlowStageTemplate(stage_key="hearing", title="構想・ヒアリング", department="product"),
    FlowStageTemplate(stage_key="requirements", title="要件定義", department="product"),
    FlowStageTemplate(
        stage_key="architecture",
        title="アーキ設計",
        department="architecture",
        skippable=True,
    ),
    FlowStageTemplate(stage_key="design", title="デザイン・モック", department="design"),
    FlowStageTemplate(stage_key="implementation", title="タスク分解・実装", department="dev_qa"),
    FlowStageTemplate(stage_key="verification", title="検証", department="dev_qa"),
    FlowStageTemplate(
        stage_key="delivery", title="リリース判定", department="executive", hard_gate=True
    ),
]

FLOW_TEMPLATES: dict[str, list[FlowStageTemplate]] = {
    "client_work": _CLIENT_WORK,
    "internal_product": _INTERNAL,
    "personal": _INTERNAL,
}


class FlowError(Exception):
    """フロー操作の構造的失敗 (code: not_found / not_skippable / hard_gate /
    already_done / bad_stage)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


_COLS = (
    "id, project_id, stage_key, seq, title, department::text as department, "
    "status, skippable, hard_gate, skip_reason, completed_at, thread_id"
)


async def _project_type(session: AsyncSession, project_id: str) -> str | None:
    row = (
        await session.execute(
            text(
                "select project_type::text as ptype from public.projects "
                "where id = cast(:p as uuid)"
            ),
            {"p": project_id},
        )
    ).first()
    return None if row is None else str(row.ptype)


async def _resolve_employees(
    session: AsyncSession, *, project_id: str
) -> dict[str, dict[str, str]]:
    """部門 → 代表社員 (is_default 優先)。COO 窓口の解決にも使う。"""
    rows = (
        await session.execute(
            text(
                "select distinct on (e.department) e.department::text as dept, "
                "e.id, e.display_name, coalesce(e.icon, '') as icon "
                "from public.ai_employees e "
                "join public.projects p on p.workspace_id = e.workspace_id "
                "where p.id = cast(:p as uuid) and e.archived = false "
                "order by e.department, e.is_default desc, e.created_at"
            ),
            {"p": project_id},
        )
    ).all()
    return {
        str(r.dept): {
            "id": str(r.id),
            "display_name": str(r.display_name),
            "icon": str(r.icon),
        }
        for r in rows
    }


async def _thread_ids_by_employee(session: AsyncSession, *, project_id: str) -> dict[str, str]:
    """社員 ID → 既存スレッド ID (最新)。フロー起点タブの遷移先に使う。"""
    rows = (
        await session.execute(
            text(
                "select distinct on (ai_employee_id) ai_employee_id, id "
                "from public.chat_threads "
                "where project_id = cast(:p as uuid) and ai_employee_id is not null "
                "order by ai_employee_id, updated_at desc"
            ),
            {"p": project_id},
        )
    ).all()
    return {str(r.ai_employee_id): str(r.id) for r in rows}


def _to_response(
    row: Any,
    *,
    current_key: str | None,
    employees: dict[str, dict[str, str]],
    threads: dict[str, str],
) -> FlowStageResponse:
    dept = str(row.department)
    emp = employees.get(dept)
    # GAP-151: 工程専用スレッド (保存済み) が正。未割当は null — 開いた時に
    # ensure_stage_thread が作成/採用する (employee 別スレッドへは飛ばさない)
    del threads
    thread_id = None if row.thread_id is None else str(row.thread_id)
    return FlowStageResponse(
        id=str(row.id),
        stage_key=str(row.stage_key),
        seq=int(row.seq),
        title=str(row.title),
        department=dept,
        status=str(row.status),  # pyright: ignore[reportArgumentType]
        skippable=bool(row.skippable),
        hard_gate=bool(row.hard_gate),
        skip_reason=None if row.skip_reason is None else str(row.skip_reason),
        completed_at=row.completed_at,
        current=str(row.stage_key) == current_key,
        employee_id=None if emp is None else emp["id"],
        employee_name=None if emp is None else emp["display_name"],
        employee_icon=None if emp is None else emp["icon"],
        thread_id=thread_id,
    )


async def get_flow(
    session: AsyncSession,
    *,
    actor_id: str,
    project_id: str,
    phase_id: str | None = None,
) -> list[FlowStageResponse] | None:
    """フローを返す (未初期化ならテンプレから自動生成)。不可視 project は None。

    自動初期化は「フローが背骨」を既定にするため — 既存プロジェクトも
    次に開いた瞬間からフローで進められる。
    GAP-152: フローはフェーズごとに 1 周。phase_id 省略時は active フェーズ。
    凍結済みフェーズを指定すると、そのフェーズ当時の周回を読み取り専用で返す。
    """
    from .phases import ensure_active_phase

    ptype = await _project_type(session, project_id)
    if ptype is None:
        return None
    active = await ensure_active_phase(session, project_id=project_id)
    target_phase = active.id
    if phase_id is not None and phase_id != active.id:
        owned = (
            await session.execute(
                text(
                    "select 1 from public.delivery_phases "
                    "where id = cast(:i as uuid) and project_id = cast(:p as uuid)"
                ),
                {"i": phase_id, "p": project_id},
            )
        ).first()
        if owned is None:
            raise FlowError("not_found", "phase not found")
        target_phase = phase_id
    rows = (
        await session.execute(
            text(
                f"select {_COLS} from public.project_flow_stages "
                "where project_id = cast(:p as uuid) "
                "and delivery_phase_id = cast(:ph as uuid) order by seq"
            ),
            {"p": project_id, "ph": target_phase},
        )
    ).all()
    if not rows and target_phase == active.id:
        template = FLOW_TEMPLATES.get(ptype, _INTERNAL)
        for i, t in enumerate(template, start=1):
            await session.execute(
                text(
                    "insert into public.project_flow_stages "
                    "(project_id, delivery_phase_id, stage_key, seq, title, department, "
                    " skippable, hard_gate) "
                    "values (cast(:p as uuid), cast(:ph as uuid), :k, :s, :t, "
                    "cast(:d as ai_employee_department_enum), :sk, :hg) "
                    "on conflict (project_id, delivery_phase_id, stage_key) do nothing"
                ),
                {
                    "p": project_id,
                    "ph": active.id,
                    "k": t.stage_key,
                    "s": i,
                    "t": t.title,
                    "d": t.department,
                    "sk": t.skippable,
                    "hg": t.hard_gate,
                },
            )
        await AuditWriter(session).write(
            AuditEvent(
                action="project.flow.init",
                target_type="project",
                actor_type="user",
                actor_id=actor_id,
                target_id=project_id,
                after={"template": ptype, "stages": len(template), "phase": active.name},
            )
        )
        rows = (
            await session.execute(
                text(
                    f"select {_COLS} from public.project_flow_stages "
                    "where project_id = cast(:p as uuid) "
                    "and delivery_phase_id = cast(:ph as uuid) order by seq"
                ),
                {"p": project_id, "ph": active.id},
            )
        ).all()
    current_key = next((str(r.stage_key) for r in rows if str(r.status) == "pending"), None)
    employees = await _resolve_employees(session, project_id=project_id)
    threads = await _thread_ids_by_employee(session, project_id=project_id)
    return [
        _to_response(r, current_key=current_key, employees=employees, threads=threads) for r in rows
    ]


async def _get_stage(session: AsyncSession, *, project_id: str, stage_key: str) -> Any:
    """active フェーズの工程行を返す (GAP-152: 操作は常に現在フェーズの周回に対して)。"""
    from .phases import ensure_active_phase

    active = await ensure_active_phase(session, project_id=project_id)
    row = (
        await session.execute(
            text(
                f"select {_COLS} from public.project_flow_stages "
                "where project_id = cast(:p as uuid) and stage_key = :k "
                "and delivery_phase_id = cast(:ph as uuid)"
            ),
            {"p": project_id, "k": stage_key, "ph": active.id},
        )
    ).first()
    if row is None:
        raise FlowError("not_found", f"stage {stage_key} not found")
    return row


async def complete_stage(
    session: AsyncSession,
    *,
    actor_id: str,
    project_id: str,
    stage_key: str,
    confirm: bool = False,
) -> list[FlowStageResponse]:
    """ステージ完了。hard_gate は confirm=true (ユーザーの明示確認) 必須。

    完了後のフロー全体を返す — UI は current の移動 (= COO の「次は◯◯です」
    引き継ぎカード) をこの応答から描く。
    """
    row = await _get_stage(session, project_id=project_id, stage_key=stage_key)
    if str(row.status) == "done":
        raise FlowError("already_done", f"{row.title} は完了済みです")
    if bool(row.hard_gate) and not confirm:
        raise FlowError(
            "hard_gate",
            f"「{row.title}」は致命工程です。内容を確認のうえ明示的に承認してください",
        )
    await session.execute(
        text(
            "update public.project_flow_stages set status = 'done', "
            "skip_reason = null, completed_at = now(), updated_at = now() "
            "where id = cast(:i as uuid)"
        ),
        {"i": str(row.id)},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="project.flow.complete",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
            after={"stage": stage_key, "hard_gate": bool(row.hard_gate)},
        )
    )
    flow = await get_flow(session, actor_id=actor_id, project_id=project_id)
    assert flow is not None
    return flow


async def skip_stage(
    session: AsyncSession,
    *,
    actor_id: str,
    project_id: str,
    stage_key: str,
    reason: str,
) -> list[FlowStageResponse]:
    """スキップ (skippable のみ・理由必須・hard_gate 不可)。"""
    row = await _get_stage(session, project_id=project_id, stage_key=stage_key)
    if bool(row.hard_gate):
        raise FlowError("hard_gate", f"「{row.title}」は致命工程のためスキップできません")
    if not bool(row.skippable):
        raise FlowError("not_skippable", f"「{row.title}」はスキップできない工程です")
    if str(row.status) == "done":
        raise FlowError("already_done", f"{row.title} は完了済みです")
    await session.execute(
        text(
            "update public.project_flow_stages set status = 'skipped', "
            "skip_reason = :r, completed_at = now(), updated_at = now() "
            "where id = cast(:i as uuid)"
        ),
        {"i": str(row.id), "r": reason[:500]},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="project.flow.skip",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
            after={"stage": stage_key, "reason": reason[:500]},
        )
    )
    flow = await get_flow(session, actor_id=actor_id, project_id=project_id)
    assert flow is not None
    return flow


async def reopen_stage(
    session: AsyncSession, *, actor_id: str, project_id: str, stage_key: str
) -> list[FlowStageResponse]:
    """差し戻し (done/skipped → pending)。後続の完了済みは保持する (実務は
    部分的な手戻りが普通 — 完了実績を勝手に消さない)。"""
    row = await _get_stage(session, project_id=project_id, stage_key=stage_key)
    if str(row.status) == "pending":
        raise FlowError("bad_stage", f"{row.title} は未完了です")
    await session.execute(
        text(
            "update public.project_flow_stages set status = 'pending', "
            "skip_reason = null, completed_at = null, updated_at = now() "
            "where id = cast(:i as uuid)"
        ),
        {"i": str(row.id)},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="project.flow.reopen",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
            after={"stage": stage_key},
        )
    )
    flow = await get_flow(session, actor_id=actor_id, project_id=project_id)
    assert flow is not None
    return flow


async def flow_context_block(session: AsyncSession, *, project_id: str) -> str:
    """チャット注入用のフロー進行状況ブロック (GAP-150)。

    全社員が「今どの工程で、担当は誰か」を知った状態で応答する。
    COO 運用の中核 — 担当外の依頼が来たら担当社員への切替を案内させる。
    未初期化 (行なし) なら空文字 (勝手に初期化しない — 書込は API 経由のみ)。
    GAP-152: 現在フェーズの周回のみを注入し、フェーズの立ち位置も伝える。
    """
    phase = (
        await session.execute(
            text(
                "select id, seq, name from public.delivery_phases "
                "where project_id = cast(:p as uuid) and status = 'active'"
            ),
            {"p": project_id},
        )
    ).first()
    if phase is None:
        return ""
    rows = (
        await session.execute(
            text(
                "select stage_key, seq, title, department::text as dept, status "
                "from public.project_flow_stages "
                "where project_id = cast(:p as uuid) "
                "and delivery_phase_id = cast(:ph as uuid) order by seq"
            ),
            {"p": project_id, "ph": str(phase.id)},
        )
    ).all()
    if not rows:
        return ""
    current = next((r for r in rows if str(r.status) == "pending"), None)
    employees = await _resolve_employees(session, project_id=project_id)
    lines = ["# プロジェクト進行フロー (この順で進める — COO 窓口運用)"]
    if int(phase.seq) > 1:
        lines.append(
            f"現在は「{phase.name}」(第 {phase.seq} フェーズ)。それ以前のフェーズは"
            "確定済みで成果物は凍結されている — 過去フェーズの成果物への追加・変更の"
            "依頼は、現在フェーズの追加要望として扱うこと (見積・タスクも現在フェーズ"
            "に分けて起こす)。"
        )
    for r in rows:
        mark = {"done": "✓", "skipped": "⤼"}.get(str(r.status), "○")
        cur = " ← 現在のステージ" if current is not None and r.seq == current.seq else ""
        emp = employees.get(str(r.dept))
        who = f" (担当: {emp['display_name']})" if emp else ""
        lines.append(f"{mark} {r.seq}. {r.title}{who}{cur}")
    lines.append(
        "自分の担当外・現在のステージ外の依頼が来たら、フロー上の担当社員への"
        "切替を案内すること。順序を飛ばす場合は理由を確認すること。"
    )
    return "\n".join(lines)


async def ensure_stage_thread(
    session: AsyncSession, *, actor_id: str, project_id: str, stage_key: str
) -> str:
    """GAP-151: 工程専用スレッドを返す (無ければ作成して project_flow_stages に固定)。

    担当社員は 工程 × 部門の代表 (運営テンプレで固定 — ユーザーは選ばない)。
    既存プロジェクトの継続性: その社員の既存スレッドがまだどの工程にも
    割り当てられていなければ採用する (会話が分断しない)。同部門の 2 工程目
    以降は新規スレッド (工程 = 会話の入れ物)。
    """
    row = await _get_stage(session, project_id=project_id, stage_key=stage_key)
    if row.thread_id is not None:
        return str(row.thread_id)
    employees = await _resolve_employees(session, project_id=project_id)
    emp = employees.get(str(row.department))
    if emp is None:
        raise FlowError(
            "no_employee",
            f"「{row.title}」の担当部門 ({row.department}) に社員がいません",
        )
    adopt = (
        await session.execute(
            text(
                "select t.id from public.chat_threads t "
                "where t.project_id = cast(:p as uuid) "
                "and t.ai_employee_id = cast(:e as uuid) "
                "and not exists (select 1 from public.project_flow_stages fs "
                "                where fs.thread_id = t.id) "
                "order by t.updated_at desc limit 1"
            ),
            {"p": project_id, "e": emp["id"]},
        )
    ).first()
    if adopt is not None:
        thread_id = str(adopt.id)
    else:
        # GAP-152: フェーズ2 以降はスレッド名にフェーズを付けて周回を区別する
        from .phases import ensure_active_phase

        active = await ensure_active_phase(session, project_id=project_id)
        title = str(row.title) if active.seq <= 1 else f"{row.title}（{active.name}）"
        thread_id = str(uuid.uuid4())
        await session.execute(
            text(
                "insert into public.chat_threads (id, project_id, ai_employee_id, title) "
                "values (cast(:i as uuid), cast(:p as uuid), cast(:e as uuid), :t)"
            ),
            {"i": thread_id, "p": project_id, "e": emp["id"], "t": title},
        )
    await session.execute(
        text(
            "update public.project_flow_stages set thread_id = cast(:t as uuid), "
            "updated_at = now() where id = cast(:i as uuid)"
        ),
        {"t": thread_id, "i": str(row.id)},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="project.flow.thread",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
            after={"stage": stage_key, "thread_id": thread_id, "adopted": adopt is not None},
        )
    )
    return thread_id
