"""GAP-114: チャットのローカル実行リレー サービス層。

S-E01 チャットの LLM 実行を、各ユーザーの PC で稼働する Bridge に中継する。
Bridge はその PC の Claude ログイン (= 本人の月額プラン) で `claude -p` を実行し、
text delta を chunks として逐次返送する。

ジョブ状態遷移:
    queued → running → done | error
    queued/running → expired (SSE 側タイムアウト時)

書き込みは全て service session (RLS バイパス) — enqueue は chat_sse、
claim/chunks/complete は routes/dispatcher の BridgeAuth 経由。
読み取り (SSE の chunk ポーリング) も service session だが、job の
requested_by/thread_id は enqueue 時に確定しており越境読み出しは発生しない。

state-changing 操作は audit_logs に記録 (actor_type='system', actor_id='bridge'
— kanban 系 bridge_tools と同一方針)。
"""

from __future__ import annotations

import uuid as uuid_mod
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter

# Bridge presence をオンラインとみなす鮮度 (秒)。S-I03 接続バッジ (90 秒) と同一。
PRESENCE_FRESH_SECONDS = 90


class ChatRelayError(Exception):
    """chat relay 操作の状態不整合 (code: not_found / invalid_state)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def _audit(
    session: AsyncSession,
    *,
    action: str,
    target_id: str,
    after: dict[str, object] | None = None,
) -> None:
    await AuditWriter(session).write(
        AuditEvent(
            action=action,
            target_type="chat_relay_job",
            actor_type="system",
            actor_id="bridge",
            target_id=target_id,
            after=after,
        )
    )


async def worker_online(session: AsyncSession) -> bool:
    """Bridge presence が鮮度内 (90 秒) の worker を 1 つでも持つか。

    relay モードで worker 不在のまま enqueue しても誰も拾わないため、
    chat_sse は送信前にこれで誠実にエラーを返す (黙って待たせない)。
    """
    res = await session.execute(
        text(
            "select 1 from public.bridge_workers "
            "where last_seen_at > now() - make_interval(secs => :fresh) limit 1"
        ),
        {"fresh": PRESENCE_FRESH_SECONDS},
    )
    return res.first() is not None


async def enqueue_job(
    session: AsyncSession,
    *,
    thread_id: str,
    requested_by: str,
    system_prompt: str,
    prompt: str,
    tools_mode: str = "off",
) -> str:
    """queued ジョブを積み、job_id を返す。

    GAP-134: tools_mode (off/approve/auto) を Bridge へ伝える — 本人の PC で
    本人のプランを使った PC 操作 (Claude Code 同等) を有効化する。
    """
    res = await session.execute(
        text(
            "insert into public.chat_relay_jobs "
            "(thread_id, requested_by, status, system_prompt, prompt, tools_mode) "
            "values (cast(:t as uuid), cast(:u as uuid), 'queued', :sp, :p, :tm) "
            "returning id"
        ),
        {
            "t": thread_id,
            "u": requested_by,
            "sp": system_prompt,
            "p": prompt,
            "tm": tools_mode,
        },
    )
    job_id = str(res.scalar_one())
    await _audit(
        session, action="chat_relay.enqueue", target_id=job_id, after={"tools_mode": tools_mode}
    )
    return job_id


async def pick_job(
    session: AsyncSession, *, worker_id: str, requested_by: str | None = None
) -> dict[str, Any] | None:
    """最古の queued job を 1 件 atomic に claim (queued→running)。

    kanban pick と同じ `for update skip locked` で並行 worker と競合しない。
    無ければ None。

    GAP-122: requested_by (user トークンの本人) が指定されたら本人の job のみ
    確保する — 他人のプロンプトが他人の PC に流れない (R-T08 系の分離)。
    """
    res = await session.execute(
        text(
            "with picked as ("
            "  select id from public.chat_relay_jobs "
            "  where status = 'queued' "
            "  and (cast(:u as uuid) is null or requested_by = cast(:u as uuid)) "
            "  order by created_at "
            "  limit 1 for update skip locked"
            ") update public.chat_relay_jobs j set status = 'running', "
            "worker_id = :w, started_at = now() "
            "where j.id in (select id from picked) "
            "returning j.id, j.system_prompt, j.prompt, j.tools_mode"
        ),
        {"w": worker_id, "u": requested_by},
    )
    row = res.first()
    if row is None:
        return None
    job_id = str(row.id)
    await _audit(
        session, action="chat_relay.pick", target_id=job_id, after={"worker_id": worker_id}
    )
    return {
        "job_id": job_id,
        "system_prompt": str(row.system_prompt),
        "prompt": str(row.prompt),
        "tools_mode": str(row.tools_mode),
    }


def _validated_job_id(job_id: str) -> str:
    """UUID 形式でない job_id は DB に触れず not_found (500 を出さない)。"""
    try:
        return str(uuid_mod.UUID(job_id))
    except ValueError:
        raise ChatRelayError("not_found", f"chat relay job {job_id!r} not found") from None


async def _job_status(session: AsyncSession, job_id: str) -> str | None:
    res = await session.execute(
        text("select status from public.chat_relay_jobs where id = cast(:i as uuid)"),
        {"i": job_id},
    )
    row = res.first()
    return None if row is None else str(row.status)


async def append_chunks(
    session: AsyncSession,
    *,
    job_id: str,
    seq_start: int,
    texts: list[str],
    kinds: list[str] | None = None,
) -> None:
    """running ジョブへ chunk を追記する (seq は seq_start からの連番)。

    GAP-134: kinds (texts と同長) で種別を指定できる — 'delta' (本文) /
    'tool' (ツール実況、content はツール名)。省略時は全て delta (後方互換)。
    running 以外 (done/expired 等) への追記は invalid_state — SSE 側が
    タイムアウト済みのジョブに遅延書き込みされるのを拒否する。
    """
    job_id = _validated_job_id(job_id)
    status = await _job_status(session, job_id)
    if status is None:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    if status != "running":
        raise ChatRelayError("invalid_state", f"job is {status}, not running")
    if kinds is not None and len(kinds) != len(texts):
        raise ChatRelayError("invalid_state", "kinds must match texts length")
    for offset, content in enumerate(texts):
        kind = "delta" if kinds is None else kinds[offset]
        if kind not in ("delta", "tool"):
            raise ChatRelayError("invalid_state", f"unknown chunk kind {kind!r}")
        await session.execute(
            text(
                "insert into public.chat_relay_chunks (job_id, seq, content, kind) "
                "values (cast(:j as uuid), :s, :c, :k) on conflict (job_id, seq) do nothing"
            ),
            {"j": job_id, "s": seq_start + offset, "c": content, "k": kind},
        )


async def complete_job(
    session: AsyncSession,
    *,
    job_id: str,
    ok: bool,
    error: str | None = None,
) -> None:
    """running ジョブを done / error で確定する。"""
    job_id = _validated_job_id(job_id)
    status = await _job_status(session, job_id)
    if status is None:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    if status != "running":
        raise ChatRelayError("invalid_state", f"job is {status}, not running")
    new_status = "done" if ok else "error"
    await session.execute(
        text(
            "update public.chat_relay_jobs set status = :st, result_error = :er, "
            "finished_at = now() where id = cast(:i as uuid)"
        ),
        {"st": new_status, "er": error, "i": job_id},
    )
    # GAP-134: 未決の承認は timeout で閉じる (SSE が resolved を配ってカードを掃除)
    await session.execute(
        text(
            "update public.chat_relay_approvals set decision = 'timeout', decided_at = now() "
            "where job_id = cast(:i as uuid) and decision = 'pending'"
        ),
        {"i": job_id},
    )
    await _audit(
        session,
        action="chat_relay.complete",
        target_id=job_id,
        after={"status": new_status, **({"error": error} if error else {})},
    )


async def expire_job(session: AsyncSession, *, job_id: str, reason: str) -> None:
    """SSE 側タイムアウト時に queued/running を expired へ落とす (冪等)。"""
    await session.execute(
        text(
            "update public.chat_relay_jobs set status = 'expired', result_error = :r, "
            "finished_at = now() "
            "where id = cast(:i as uuid) and status in ('queued', 'running')"
        ),
        {"r": reason, "i": job_id},
    )
    await _audit(session, action="chat_relay.expire", target_id=job_id, after={"reason": reason})


async def fetch_chunks(
    session: AsyncSession,
    *,
    job_id: str,
    after_seq: int,
) -> list[tuple[int, str, str]]:
    """after_seq より後の chunk を (seq, kind, content) の昇順で返す。"""
    res = await session.execute(
        text(
            "select seq, kind, content from public.chat_relay_chunks "
            "where job_id = cast(:j as uuid) and seq > :s order by seq"
        ),
        {"j": job_id, "s": after_seq},
    )
    return [(int(r.seq), str(r.kind), str(r.content)) for r in res.all()]


# ── GAP-134: PC 操作の承認往復 (Bridge ⇄ サーバー ⇄ ユーザー) ────────


async def create_approval(session: AsyncSession, *, job_id: str, tool: str, summary: str) -> str:
    """Bridge が CLI の許可要求を受けて承認行を作る (pending)。"""
    job_id = _validated_job_id(job_id)
    status = await _job_status(session, job_id)
    if status is None:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    if status != "running":
        raise ChatRelayError("invalid_state", f"job is {status}, not running")
    res = await session.execute(
        text(
            "insert into public.chat_relay_approvals (job_id, tool, summary) "
            "values (cast(:j as uuid), :t, :s) returning id"
        ),
        {"j": job_id, "t": tool, "s": summary[:500]},
    )
    approval_id = str(res.scalar_one())
    await _audit(
        session,
        action="chat_relay.approval_request",
        target_id=approval_id,
        after={"job_id": job_id, "tool": tool},
    )
    return approval_id


async def approval_decision(session: AsyncSession, *, job_id: str, approval_id: str) -> str:
    """Bridge がポーリングする決定 (pending/allow/deny/timeout)。"""
    res = await session.execute(
        text(
            "select decision from public.chat_relay_approvals "
            "where id = cast(:a as uuid) and job_id = cast(:j as uuid)"
        ),
        {"a": _validated_job_id(approval_id), "j": _validated_job_id(job_id)},
    )
    row = res.first()
    if row is None:
        raise ChatRelayError("not_found", f"approval {approval_id} not found")
    return str(row.decision)


async def list_job_approvals(session: AsyncSession, *, job_id: str) -> list[dict[str, str]]:
    """job の承認行を作成順で返す (SSE が pending の出現/解決を検知する)。"""
    res = await session.execute(
        text(
            "select id, tool, summary, decision from public.chat_relay_approvals "
            "where job_id = cast(:j as uuid) order by created_at"
        ),
        {"j": job_id},
    )
    return [
        {
            "id": str(r.id),
            "tool": str(r.tool),
            "summary": str(r.summary),
            "decision": str(r.decision),
        }
        for r in res.all()
    ]


async def resolve_approval_for_user(
    session: AsyncSession, *, approval_id: str, user_id: str, decision: str
) -> bool:
    """ユーザーの決定 (allow/deny) を承認行へ書く。

    本人の job に紐づく pending の行のみ更新できる (他人の承認 ID や解決済みは
    False — 呼出側は 404 にする)。service セッションで呼ぶこと (RLS は
    default deny で UPDATE policy を作っていない)。
    """
    if decision not in ("allow", "deny"):
        return False
    try:
        validated = _validated_job_id(approval_id)
    except ChatRelayError:
        return False
    res = await session.execute(
        text(
            "update public.chat_relay_approvals a set decision = :d, decided_at = now() "
            "where a.id = cast(:a as uuid) and a.decision = 'pending' "
            "and exists ("
            "  select 1 from public.chat_relay_jobs j "
            "  where j.id = a.job_id and j.requested_by = cast(:u as uuid)"
            ") returning a.id"
        ),
        {"d": decision, "a": validated, "u": user_id},
    )
    ok = res.first() is not None
    if ok:
        await _audit(
            session,
            action="chat_relay.approval_decision",
            target_id=validated,
            after={"decision": decision},
        )
    return ok


async def job_result(session: AsyncSession, *, job_id: str) -> tuple[str, str | None]:
    """(status, result_error) を返す。存在しなければ not_found。"""
    res = await session.execute(
        text("select status, result_error from public.chat_relay_jobs where id = cast(:i as uuid)"),
        {"i": job_id},
    )
    row = res.first()
    if row is None:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    return str(row.status), None if row.result_error is None else str(row.result_error)


# ── GAP-119: Claude プラン接続の状態表示 ────────────────────────

_RATE_LIMIT_STATUSES = ("allowed", "allowed_warning", "rejected")


async def record_plan_status(
    session: AsyncSession,
    *,
    job_id: str,
    observations: list[dict[str, Any]],
) -> None:
    """Bridge が返送した rate_limit_event 観測値を job の本人へ upsert する。"""
    job_id = _validated_job_id(job_id)
    res = await session.execute(
        text("select requested_by from public.chat_relay_jobs where id = cast(:i as uuid)"),
        {"i": job_id},
    )
    row = res.first()
    if row is None:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    await record_plan_status_for_user(
        session, user_id=str(row.requested_by), observations=observations
    )


async def record_plan_status_for_user(
    session: AsyncSession,
    *,
    user_id: str,
    observations: list[dict[str, Any]],
) -> None:
    """rate_limit_event 観測値を本人の chat_plan_status へ upsert する。

    値は claude CLI が実行中に発行した実値のみ (推測で補完しない)。
    five_hour / seven_day 以外の window は overall status にだけ寄与する。
    観測が空・不正のみなら何も書かない (誠実: 無いものは無いまま)。
    relay (GAP-119) と agent_sdk (GAP-124) の両経路がここに合流する。
    """
    worst = -1
    fields: dict[str, Any] = {
        "five_hour_utilization": None,
        "five_hour_resets_at": None,
        "seven_day_utilization": None,
        "seven_day_resets_at": None,
    }
    for obs in observations:
        status = obs.get("status")
        if status not in _RATE_LIMIT_STATUSES:
            continue
        worst = max(worst, _RATE_LIMIT_STATUSES.index(str(status)))
        window = obs.get("rate_limit_type")
        if window not in ("five_hour", "seven_day"):
            continue
        utilization = obs.get("utilization")
        if isinstance(utilization, int | float) and 0 <= float(utilization) <= 2:
            fields[f"{window}_utilization"] = float(utilization)
        resets_at = obs.get("resets_at")
        if isinstance(resets_at, int | float) and resets_at > 0:
            fields[f"{window}_resets_at"] = float(resets_at)
    if worst < 0:
        return

    await session.execute(
        text(
            "insert into public.chat_plan_status "
            "(user_id, status, five_hour_utilization, five_hour_resets_at, "
            " seven_day_utilization, seven_day_resets_at, observed_at) "
            "values (cast(:u as uuid), :st, :fu, to_timestamp(:fr), :su, to_timestamp(:sr), now()) "
            "on conflict (user_id) do update set "
            "status = excluded.status, "
            "five_hour_utilization = excluded.five_hour_utilization, "
            "five_hour_resets_at = excluded.five_hour_resets_at, "
            "seven_day_utilization = excluded.seven_day_utilization, "
            "seven_day_resets_at = excluded.seven_day_resets_at, "
            "observed_at = now()"
        ),
        {
            "u": user_id,
            "st": _RATE_LIMIT_STATUSES[worst],
            "fu": fields["five_hour_utilization"],
            "fr": fields["five_hour_resets_at"],
            "su": fields["seven_day_utilization"],
            "sr": fields["seven_day_resets_at"],
        },
    )


async def connection_status(session: AsyncSession, *, user_id: str) -> dict[str, Any]:
    """S-E01 接続状態パネル用の実測値を返す (取れない値は null のまま)。

    - workers: presence 鮮度内 (90 秒) の Bridge (host/version/last_seen_at)
    - last_job: 本人の直近 relay 実行 (status/created_at/finished_at/error)
    - plan: 本人の直近プラン枠観測 (chat_plan_status — 無ければ null)
    """
    # GAP-122: 自分の worker (user_id = 本人) と インスタンス worker (user_id null)
    # のみを見せる — 他ユーザーの Bridge は自分の接続状態ではない
    workers_res = await session.execute(
        text(
            "select host_label, version, last_seen_at from public.bridge_workers "
            "where last_seen_at > now() - make_interval(secs => :fresh) "
            "and (user_id is null or user_id = cast(:u as uuid)) "
            "order by last_seen_at desc limit 10"
        ),
        {"fresh": PRESENCE_FRESH_SECONDS, "u": user_id},
    )
    workers = [
        {
            "host_label": str(r.host_label),
            "version": str(r.version),
            "last_seen_at": r.last_seen_at.isoformat(),
        }
        for r in workers_res.all()
    ]

    job_res = await session.execute(
        text(
            "select status, result_error, created_at, finished_at "
            "from public.chat_relay_jobs where requested_by = cast(:u as uuid) "
            "order by created_at desc limit 1"
        ),
        {"u": user_id},
    )
    job_row = job_res.first()
    last_job = (
        None
        if job_row is None
        else {
            "status": str(job_row.status),
            "error": None if job_row.result_error is None else str(job_row.result_error),
            "created_at": job_row.created_at.isoformat(),
            "finished_at": (
                None if job_row.finished_at is None else job_row.finished_at.isoformat()
            ),
        }
    )

    plan_res = await session.execute(
        text(
            "select status, five_hour_utilization, five_hour_resets_at, "
            "seven_day_utilization, seven_day_resets_at, observed_at "
            "from public.chat_plan_status where user_id = cast(:u as uuid)"
        ),
        {"u": user_id},
    )
    plan_row = plan_res.first()
    plan = (
        None
        if plan_row is None
        else {
            "status": str(plan_row.status),
            "five_hour_utilization": (
                None
                if plan_row.five_hour_utilization is None
                else float(plan_row.five_hour_utilization)
            ),
            "five_hour_resets_at": (
                None
                if plan_row.five_hour_resets_at is None
                else plan_row.five_hour_resets_at.isoformat()
            ),
            "seven_day_utilization": (
                None
                if plan_row.seven_day_utilization is None
                else float(plan_row.seven_day_utilization)
            ),
            "seven_day_resets_at": (
                None
                if plan_row.seven_day_resets_at is None
                else plan_row.seven_day_resets_at.isoformat()
            ),
            "observed_at": plan_row.observed_at.isoformat(),
        }
    )

    return {
        "bridge_online": len(workers) > 0,
        "workers": workers,
        "last_job": last_job,
        "plan": plan,
    }
