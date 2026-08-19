"""GAP-152: 段階的フェーズ (delivery_phases) サービス層。

経営者すり合わせ:
  - フェーズ確定 = 成果物の凍結 (スナップショット)。それ以上の追加は
    次フェーズ (フェーズ2以降) で行い、見積・タスク・依存も分けて考える。
  - プロジェクト内でフェーズを切り替えて過去フェーズを閲覧できる。
  - フロー (工程) はフェーズごとに 1 周する。

active はプロジェクトにちょうど 1 つ (partial unique index)。確定は
confirm 必須 (hard gate と同じ「明示承認」運用) で、frozen 化と同時に
次フェーズを active として作る — 「現在のフェーズが無い」状態を作らない。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.flow import DeliveryPhaseResponse


class PhaseError(Exception):
    """フェーズ操作の構造的失敗 (code: not_found / not_active / confirm_required)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ActivePhase:
    id: str
    seq: int
    name: str


async def ensure_active_phase(session: AsyncSession, *, project_id: str) -> ActivePhase:
    """active フェーズを返す (無ければフェーズ1 を作る)。

    既存プロジェクトは migration で backfill 済み — ここは新規プロジェクトの
    初回アクセスと、並列初回アクセスの競合 (unique 違反 → 再読) を吸収する。
    """
    row = (
        await session.execute(
            text(
                "select id, seq, name from public.delivery_phases "
                "where project_id = cast(:p as uuid) and status = 'active'"
            ),
            {"p": project_id},
        )
    ).first()
    if row is not None:
        return ActivePhase(id=str(row.id), seq=int(row.seq), name=str(row.name))
    next_seq = int(
        (
            await session.execute(
                text(
                    "select coalesce(max(seq), 0) + 1 from public.delivery_phases "
                    "where project_id = cast(:p as uuid)"
                ),
                {"p": project_id},
            )
        ).scalar_one()
    )
    try:
        async with session.begin_nested():
            created = (
                await session.execute(
                    text(
                        "insert into public.delivery_phases (project_id, seq, name) "
                        "values (cast(:p as uuid), :s, :n) returning id, seq, name"
                    ),
                    {"p": project_id, "s": next_seq, "n": f"フェーズ{next_seq}"},
                )
            ).one()
    except IntegrityError:
        # 並列初回アクセス — 先に作られた active を読む
        row2 = (
            await session.execute(
                text(
                    "select id, seq, name from public.delivery_phases "
                    "where project_id = cast(:p as uuid) and status = 'active'"
                ),
                {"p": project_id},
            )
        ).one()
        return ActivePhase(id=str(row2.id), seq=int(row2.seq), name=str(row2.name))
    return ActivePhase(id=str(created.id), seq=int(created.seq), name=str(created.name))


def _to_response(row: Any) -> DeliveryPhaseResponse:
    return DeliveryPhaseResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        seq=int(row.seq),
        name=str(row.name),
        status=str(row.status),  # pyright: ignore[reportArgumentType]
        note=None if row.note is None else str(row.note),
        frozen_at=row.frozen_at,
        mock_count=int(row.mock_count),
        output_count=int(row.output_count),
        task_count=int(row.task_count),
        stages_done=int(row.stages_done),
        stages_total=int(row.stages_total),
    )


_PHASE_COLS = """
  dp.id, dp.project_id, dp.seq, dp.name, dp.status, dp.note, dp.frozen_at,
  (select count(*) from public.mocks m
    where m.delivery_phase_id = dp.id and m.deleted_at is null) as mock_count,
  (select count(*) from public.workflow_outputs wo
    where wo.delivery_phase_id = dp.id and wo.deleted_at is null) as output_count,
  (select count(*) from public.tasks t
    where t.delivery_phase_id = dp.id and t.deleted_at is null) as task_count,
  (select count(*) from public.project_flow_stages fs
    where fs.delivery_phase_id = dp.id and fs.status in ('done', 'skipped')) as stages_done,
  (select count(*) from public.project_flow_stages fs
    where fs.delivery_phase_id = dp.id) as stages_total
"""


async def list_phases(
    session: AsyncSession, *, project_id: str
) -> list[DeliveryPhaseResponse] | None:
    """フェーズ一覧 (seq 昇順 + フェーズ別の成果物/モック/タスク/工程 実数)。

    project 不可視は None。未初期化ならフェーズ1 を自動作成する。
    """
    visible = (
        await session.execute(
            text("select 1 from public.projects where id = cast(:p as uuid)"),
            {"p": project_id},
        )
    ).first()
    if visible is None:
        return None
    await ensure_active_phase(session, project_id=project_id)
    rows = (
        await session.execute(
            text(
                f"select {_PHASE_COLS} from public.delivery_phases dp "
                "where dp.project_id = cast(:p as uuid) order by dp.seq"
            ),
            {"p": project_id},
        )
    ).all()
    return [_to_response(r) for r in rows]


async def freeze_phase(
    session: AsyncSession,
    *,
    actor_id: str,
    project_id: str,
    phase_id: str,
    confirm: bool = False,
    note: str | None = None,
) -> list[DeliveryPhaseResponse]:
    """フェーズ確定 (凍結) — confirm 必須 (hard gate と同じ明示承認運用)。

    frozen 化と同時に次フェーズを active として作成し、フロー (工程) は
    次フェーズで新しい 1 周が始まる (get_flow が自動初期化)。凍結後の
    フェーズには新規成果物が入らない — スタンプは常に active フェーズ。
    """
    row = (
        await session.execute(
            text(
                "select id, seq, name, status from public.delivery_phases "
                "where id = cast(:i as uuid) and project_id = cast(:p as uuid)"
            ),
            {"i": phase_id, "p": project_id},
        )
    ).first()
    if row is None:
        raise PhaseError("not_found", "phase not found")
    if str(row.status) != "active":
        raise PhaseError("not_active", f"「{row.name}」はすでに確定済みです")
    if not confirm:
        raise PhaseError(
            "confirm_required",
            f"「{row.name}」を確定すると成果物が凍結され、以後の追加は次フェーズに"
            "なります。内容を確認のうえ明示的に承認してください",
        )
    await session.execute(
        text(
            "update public.delivery_phases set status = 'frozen', frozen_at = now(), "
            "frozen_by = cast(:u as uuid), note = :n, updated_at = now() "
            "where id = cast(:i as uuid)"
        ),
        {"i": phase_id, "u": actor_id, "n": None if note is None else note[:500]},
    )
    next_seq = int(row.seq) + 1
    await session.execute(
        text(
            "insert into public.delivery_phases (project_id, seq, name) "
            "values (cast(:p as uuid), :s, :n)"
        ),
        {"p": project_id, "s": next_seq, "n": f"フェーズ{next_seq}"},
    )
    # 次フェーズのフロー (工程 1 周) を即時初期化 — 「確定した瞬間に現在工程が
    # 無い」空白を作らない
    from . import get_flow

    await get_flow(session, actor_id=actor_id, project_id=project_id)
    await AuditWriter(session).write(
        AuditEvent(
            action="project.phase.freeze",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
            after={"phase": str(row.name), "seq": int(row.seq), "next_seq": next_seq},
        )
    )
    phases = await list_phases(session, project_id=project_id)
    assert phases is not None
    return phases


async def frozen_phase_of(session: AsyncSession, *, delivery_phase_id: str | None) -> str | None:
    """行の帰属フェーズが凍結済みならフェーズ名を返す (未凍結/未帰属は None)。

    破壊的操作 (モックの破棄・削除・メタ更新等) のガードに使う。
    """
    if delivery_phase_id is None:
        return None
    row = (
        await session.execute(
            text(
                "select name from public.delivery_phases "
                "where id = cast(:i as uuid) and status = 'frozen'"
            ),
            {"i": delivery_phase_id},
        )
    ).first()
    return None if row is None else str(row.name)


async def phase_history_block(session: AsyncSession, *, project_id: str) -> str:
    """チャット注入用: 確定済みフェーズの中身サマリー (GAP-157)。

    経営者指示「切り替えても前フェーズを把握して、依存もタスク分解も徹底できる
    状態で」— 画面の表示はヘッダーで切り替えるが、AI は常に全フェーズを把握して
    依存関係・追加分のタスク分解を前フェーズの実物 (成果物/モック/工程) を
    踏まえて行う。確定フェーズが無ければ空文字。
    """
    frozen = (
        await session.execute(
            text(
                "select id, seq, name, frozen_at from public.delivery_phases "
                "where project_id = cast(:p as uuid) and status = 'frozen' order by seq"
            ),
            {"p": project_id},
        )
    ).all()
    if not frozen:
        return ""
    lines = ["# 確定済みフェーズの内容 (凍結スナップショット — 依存・追加タスク分解の前提)"]
    for ph in frozen:
        outs = (
            await session.execute(
                text(
                    "select stage::text as stage, coalesce(summary, '') as title, "
                    "max(version) as ver from public.workflow_outputs "
                    "where delivery_phase_id = cast(:d as uuid) and deleted_at is null "
                    "group by stage, summary order by stage limit 15"
                ),
                {"d": str(ph.id)},
            )
        ).all()
        mocks = (
            await session.execute(
                text(
                    "select screen_name, max(version) as ver from public.mocks "
                    "where delivery_phase_id = cast(:d as uuid) and deleted_at is null "
                    "group by screen_name order by screen_name limit 12"
                ),
                {"d": str(ph.id)},
            )
        ).all()
        stages = (
            await session.execute(
                text(
                    "select title, status from public.project_flow_stages "
                    "where delivery_phase_id = cast(:d as uuid) "
                    "and status in ('done', 'skipped') order by seq"
                ),
                {"d": str(ph.id)},
            )
        ).all()
        frozen_date = "" if ph.frozen_at is None else str(ph.frozen_at)[:10]
        lines.append(f"## {ph.name}（{frozen_date} 確定）")
        if stages:
            lines.append(
                "完了工程: " + " / ".join(str(s.title) for s in stages if s.status == "done")
            )
        if outs:
            lines.append(
                "成果物: " + " / ".join(f"{o.title}(v{o.ver}, {o.stage})" for o in outs if o.title)
            )
        if mocks:
            lines.append("画面モック: " + " / ".join(f"{m.screen_name}(v{m.ver})" for m in mocks))
    lines.append(
        "これらは凍結済み — 変更・追加はすべて現在フェーズの作業として扱い、"
        "新しいタスク・依存は上記の確定内容 (既存画面・既存成果物・既存実装) を"
        "前提に分解すること。"
    )
    block = "\n".join(lines)
    return block[:3000]
