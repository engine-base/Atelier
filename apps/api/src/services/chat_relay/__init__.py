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
) -> str:
    """queued ジョブを積み、job_id を返す。"""
    res = await session.execute(
        text(
            "insert into public.chat_relay_jobs "
            "(thread_id, requested_by, status, system_prompt, prompt) "
            "values (cast(:t as uuid), cast(:u as uuid), 'queued', :sp, :p) "
            "returning id"
        ),
        {"t": thread_id, "u": requested_by, "sp": system_prompt, "p": prompt},
    )
    job_id = str(res.scalar_one())
    await _audit(session, action="chat_relay.enqueue", target_id=job_id)
    return job_id


async def pick_job(session: AsyncSession, *, worker_id: str) -> dict[str, Any] | None:
    """最古の queued job を 1 件 atomic に claim (queued→running)。

    kanban pick と同じ `for update skip locked` で並行 worker と競合しない。
    無ければ None。
    """
    res = await session.execute(
        text(
            "with picked as ("
            "  select id from public.chat_relay_jobs "
            "  where status = 'queued' "
            "  order by created_at "
            "  limit 1 for update skip locked"
            ") update public.chat_relay_jobs j set status = 'running', "
            "worker_id = :w, started_at = now() "
            "where j.id in (select id from picked) "
            "returning j.id, j.system_prompt, j.prompt"
        ),
        {"w": worker_id},
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
) -> None:
    """running ジョブへ text delta を追記する (seq は seq_start からの連番)。

    running 以外 (done/expired 等) への追記は invalid_state — SSE 側が
    タイムアウト済みのジョブに遅延書き込みされるのを拒否する。
    """
    job_id = _validated_job_id(job_id)
    status = await _job_status(session, job_id)
    if status is None:
        raise ChatRelayError("not_found", f"chat relay job {job_id} not found")
    if status != "running":
        raise ChatRelayError("invalid_state", f"job is {status}, not running")
    for offset, content in enumerate(texts):
        await session.execute(
            text(
                "insert into public.chat_relay_chunks (job_id, seq, content) "
                "values (cast(:j as uuid), :s, :c) on conflict (job_id, seq) do nothing"
            ),
            {"j": job_id, "s": seq_start + offset, "c": content},
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
) -> list[tuple[int, str]]:
    """after_seq より後の chunk を seq 昇順で返す (SSE 中継のポーリング単位)。"""
    res = await session.execute(
        text(
            "select seq, content from public.chat_relay_chunks "
            "where job_id = cast(:j as uuid) and seq > :s order by seq"
        ),
        {"j": job_id, "s": after_seq},
    )
    return [(int(r.seq), str(r.content)) for r in res.all()]


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
