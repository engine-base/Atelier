"""GAP-189: 実行の制御 — 中断・追い足し指示・繋ぎ直し。

経営者指摘:
    「中断とか入ってないけど、これ Claude だとできるけど」
    「止まっても裏のターミナルは変わらないんでしょ？ だったら続けてとかで
      自動で後ろは繋がるよね？」

このモジュールは 3 つを担う。どれも「取りこぼさない」ことが要点:

1. **中断**   — 人が止めたら、クラウドの状態を落とすだけでなく
                **本人の PC で走っている claude も実際に止める**。
                そこまでに出た分は捨てずにスレッドへ残す。
2. **追い足し** — 実行中に送られた指示は、受け取った瞬間に DB へ入れる。
                ブラウザが落ちても消えず、次の実行で必ず消費される。
3. **繋ぎ直し** — 返答の保存を**ブラウザではなくサーバーのジョブ確定に紐づける**。
                画面を閉じても、PC が仕事を終えていれば答えはスレッドに残る。

書き込みは service session (RLS バイパス)。本人性はこのモジュール内で
requested_by 照合により検証する (他人の実行は止められない / 見られない)。
"""

from __future__ import annotations

import json
import uuid as uuid_mod
from dataclasses import dataclass
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter

#: 中断されたと分かるよう返答の末尾に付ける印。本文として読める形にする。
CANCEL_NOTE = "\n\n---\n（ここで中断しました）"

#: 1 スレッドに積める追い足し指示の上限。無制限にすると事故で暴走する。
MAX_QUEUED_PER_THREAD = 20

#: 追い足し指示 1 件の最大長 (DB の check 制約と一致させる)。
MAX_QUEUED_CHARS = 20_000


class RunControlError(Exception):
    """実行制御の状態不整合 (code: not_found / forbidden / invalid_state / too_many)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _uuid_or_error(value: str, what: str) -> str:
    try:
        return str(uuid_mod.UUID(value))
    except ValueError:
        raise RunControlError("not_found", f"{what}が見つかりません。") from None


def _loads(raw: Any) -> list[dict[str, Any]]:
    """jsonb 列を list に戻す (driver により str / list のどちらでも来る)。"""
    parsed: Any = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(parsed, list):
        return []
    out: list[dict[str, Any]] = []
    for item in cast("list[Any]", parsed):
        if isinstance(item, dict):
            out.append(cast("dict[str, Any]", item))
    return out


# ────────────────────────────────────────────────────────────────────
# 3. 繋ぎ直し — 返答の保存をサーバー側に寄せる
# ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PersistResult:
    """返答の保存結果。"""

    message_id: str | None
    chars: int
    created: bool  # 今回このジョブの返答を新しく保存したか


async def assemble_answer(session: AsyncSession, *, job_id: str) -> str:
    """DB に溜まった chunk から返答本文を組み立てる。

    ツール実況 (kind='tool') や成果物 (kind='artifact') は本文ではないので除く。
    """
    job_id = _uuid_or_error(job_id, "実行")
    res = await session.execute(
        text(
            "select content from public.chat_relay_chunks "
            "where job_id = cast(:j as uuid) and kind = 'delta' order by seq"
        ),
        {"j": job_id},
    )
    return "".join(str(r.content) for r in res.all())


async def persist_answer(
    session: AsyncSession, *, job_id: str, thread_id: str, note: str = ""
) -> PersistResult:
    """このジョブの返答をスレッドへ保存する (冪等)。

    **ブラウザではなくサーバーが保存する**のが要点。従来は SSE の generator を
    抜けた後に保存していたので、生成中に画面を閉じると PC が最後まで仕事をして
    chunk も残っているのに、その回の答えだけがスレッドから消えていた。

    すでに保存済みなら何もしない (二重投稿を作らない)。本文が空なら保存しない
    (空の吹き出しを並べない)。
    """
    job_id = _uuid_or_error(job_id, "実行")
    row = (
        await session.execute(
            text(
                "select assistant_message_id from public.chat_relay_jobs "
                "where id = cast(:i as uuid)"
            ),
            {"i": job_id},
        )
    ).first()
    if row is None:
        raise RunControlError("not_found", "実行が見つかりません。")
    if row.assistant_message_id is not None:
        existing = str(row.assistant_message_id)
        length = (
            await session.execute(
                text(
                    "select char_length(content) as n from public.chat_messages "
                    "where id = cast(:i as uuid)"
                ),
                {"i": existing},
            )
        ).first()
        return PersistResult(existing, 0 if length is None else int(length.n), False)

    body = await assemble_answer(session, job_id=job_id)
    if body.strip() == "":
        return PersistResult(None, 0, False)
    body = f"{body}{note}"

    new_id = str(uuid_mod.uuid4())
    await session.execute(
        text(
            "insert into public.chat_messages "
            "(id, thread_id, role, content, attachments, created_at) "
            "values (cast(:i as uuid), cast(:t as uuid), 'assistant', :c, "
            " cast('[]' as jsonb), clock_timestamp())"
        ),
        {"i": new_id, "t": thread_id, "c": body},
    )
    await session.execute(
        text(
            "update public.chat_relay_jobs set assistant_message_id = cast(:m as uuid) "
            "where id = cast(:i as uuid)"
        ),
        {"m": new_id, "i": job_id},
    )
    return PersistResult(new_id, len(body), True)


async def saved_answer(session: AsyncSession, *, job_id: str) -> PersistResult:
    """このジョブの返答が保存済みかを読むだけの版 (書き込まない)。

    中断直後に画面へ「ここまで何文字残したか」を返すために使う。
    """
    job_id = _uuid_or_error(job_id, "実行")
    row = (
        await session.execute(
            text(
                "select m.id as mid, char_length(m.content) as n "
                "from public.chat_relay_jobs j "
                "join public.chat_messages m on m.id = j.assistant_message_id "
                "where j.id = cast(:i as uuid)"
            ),
            {"i": job_id},
        )
    ).first()
    if row is None:
        return PersistResult(None, 0, False)
    return PersistResult(str(row.mid), int(row.n), False)


# ────────────────────────────────────────────────────────────────────
# 1. 中断
# ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CancelResult:
    """中断の結果。画面にそのまま出せる日本語つき。"""

    status: str  # "cancelled" | "already_finished"
    message: str
    assistant_message_id: str | None = None
    saved_chars: int = 0


async def request_cancel(session: AsyncSession, *, job_id: str, actor_id: str) -> CancelResult:
    """走っている実行を止める。

    `cancelled` は終端状態にする — 画面に「止まった」と即返せるようにするため。
    Bridge は次のポーリング (または chunk 追記が弾かれたこと) で気づき、
    **PC 上の claude を kill する**。クラウドの状態だけ落として PC で走らせ
    続ける、という嘘の中断にはしない。

    そこまでに出ていた本文は捨てずにスレッドへ保存する (途中まで書けた提案を
    人が読めるようにする)。
    """
    job_id = _uuid_or_error(job_id, "実行")
    row = (
        await session.execute(
            text(
                "select status, requested_by, thread_id from public.chat_relay_jobs "
                "where id = cast(:i as uuid) for update"
            ),
            {"i": job_id},
        )
    ).first()
    if row is None:
        raise RunControlError("not_found", "実行が見つかりません。")
    if str(row.requested_by) != str(actor_id):
        # 他人の PC で走っているものを止められない (R-T08 系の分離)。
        raise RunControlError("forbidden", "この実行を止める権限がありません。")

    if str(row.status) not in ("queued", "running"):
        return CancelResult("already_finished", "この実行はすでに終了しています。")

    await session.execute(
        text(
            "update public.chat_relay_jobs "
            "set status = 'cancelled', cancel_requested_at = now(), finished_at = now() "
            "where id = cast(:i as uuid)"
        ),
        {"i": job_id},
    )
    # 未決の承認カードは閉じる (止めたのに承認待ちが残らないように)。
    await session.execute(
        text(
            "update public.chat_relay_approvals set decision = 'timeout', decided_at = now() "
            "where job_id = cast(:i as uuid) and decision = 'pending'"
        ),
        {"i": job_id},
    )

    saved_id: str | None = None
    saved_chars = 0
    if row.thread_id is not None:
        saved = await persist_answer(
            session, job_id=job_id, thread_id=str(row.thread_id), note=CANCEL_NOTE
        )
        saved_id = saved.message_id
        saved_chars = saved.chars

    await AuditWriter(session).write(
        AuditEvent(
            action="chat_relay.cancel",
            target_type="chat_relay_job",
            actor_type="user",
            actor_id=str(actor_id),
            target_id=job_id,
            after={"saved_chars": saved_chars},
        )
    )
    message = (
        "実行を止めました。ここまでの内容はスレッドに残しています。"
        if saved_chars > 0
        else "実行を止めました。"
    )
    return CancelResult("cancelled", message, saved_id, saved_chars)


async def cancel_requested(session: AsyncSession, *, job_id: str) -> bool:
    """Bridge が見る「止めろと言われているか」。

    PC 側はこれを見て子プロセスを kill する。ジョブが既に cancelled/expired に
    なっている場合も真 — どちらも「もう走らせておく理由が無い」状態だから。
    存在しない (消された) ジョブも真にする。
    """
    job_id = _uuid_or_error(job_id, "実行")
    row = (
        await session.execute(
            text(
                "select status, cancel_requested_at from public.chat_relay_jobs "
                "where id = cast(:i as uuid)"
            ),
            {"i": job_id},
        )
    ).first()
    if row is None:
        return True
    if row.cancel_requested_at is not None:
        return True
    return str(row.status) in ("cancelled", "expired")


@dataclass(frozen=True)
class ActiveRun:
    """今このスレッドで走っている実行。"""

    job_id: str
    status: str
    started_at: Any
    tools_mode: str


async def active_run(session: AsyncSession, *, thread_id: str, actor_id: str) -> ActiveRun | None:
    """このスレッドで今走っている実行 (本人のもののみ)。

    画面を開き直したときに「まだ走っています」と分かり、繋ぎ直せるようにする。
    """
    thread_id = _uuid_or_error(thread_id, "スレッド")
    row = (
        await session.execute(
            text(
                "select id, status, started_at, tools_mode from public.chat_relay_jobs "
                "where thread_id = cast(:t as uuid) and requested_by = cast(:u as uuid) "
                "and status in ('queued', 'running') "
                "order by created_at desc limit 1"
            ),
            {"t": thread_id, "u": actor_id},
        )
    ).first()
    if row is None:
        return None
    return ActiveRun(str(row.id), str(row.status), row.started_at, str(row.tools_mode))


@dataclass(frozen=True)
class RunSnapshot:
    """繋ぎ直し用のジョブ 1 件の状態。"""

    job_id: str
    thread_id: str | None
    status: str
    error: str | None
    assistant_message_id: str | None


async def run_snapshot(session: AsyncSession, *, job_id: str, actor_id: str) -> RunSnapshot:
    """本人のジョブの現在地を返す (繋ぎ直しの認可もここで行う)。"""
    job_id = _uuid_or_error(job_id, "実行")
    row = (
        await session.execute(
            text(
                "select requested_by, thread_id, status, result_error, assistant_message_id "
                "from public.chat_relay_jobs where id = cast(:i as uuid)"
            ),
            {"i": job_id},
        )
    ).first()
    if row is None:
        raise RunControlError("not_found", "実行が見つかりません。")
    if str(row.requested_by) != str(actor_id):
        raise RunControlError("forbidden", "この実行を見る権限がありません。")
    return RunSnapshot(
        job_id=job_id,
        thread_id=None if row.thread_id is None else str(row.thread_id),
        status=str(row.status),
        error=None if row.result_error is None else str(row.result_error),
        assistant_message_id=(
            None if row.assistant_message_id is None else str(row.assistant_message_id)
        ),
    )


# ────────────────────────────────────────────────────────────────────
# 2. 実行中の追い足し指示
# ────────────────────────────────────────────────────────────────────


async def queue_message(
    session: AsyncSession,
    *,
    thread_id: str,
    actor_id: str,
    content: str,
    attachments: list[dict[str, Any]] | None = None,
    tools_mode: str = "off",
) -> dict[str, Any]:
    """実行中に送られた指示を**受け取った瞬間に**保存する。

    ここで保存するので、この後ブラウザが落ちても指示は消えない。
    実行が終わったら consume_next() で順に取り出して普通の 1 ターンとして流す。
    """
    thread_id = _uuid_or_error(thread_id, "スレッド")
    body = content.strip()
    if body == "":
        raise RunControlError("invalid_state", "空の指示は積めません。")
    if len(body) > MAX_QUEUED_CHARS:
        raise RunControlError("invalid_state", f"指示が長すぎます ({MAX_QUEUED_CHARS:,} 字まで)。")
    if tools_mode not in ("off", "approve", "auto"):
        raise RunControlError("invalid_state", f"不明な実行モードです: {tools_mode}")

    pending = await session.execute(
        text(
            "select count(*) as n from public.chat_queued_messages "
            "where thread_id = cast(:t as uuid) and requested_by = cast(:u as uuid) "
            "and consumed_at is null"
        ),
        {"t": thread_id, "u": actor_id},
    )
    if int(pending.scalar_one()) >= MAX_QUEUED_PER_THREAD:
        raise RunControlError(
            "too_many",
            f"待ちの指示が上限 ({MAX_QUEUED_PER_THREAD} 件) に達しています。"
            "今の実行が終わるのを待つか、待ちの指示を減らしてください。",
        )

    new_id = str(uuid_mod.uuid4())
    await session.execute(
        text(
            "insert into public.chat_queued_messages "
            "(id, thread_id, requested_by, content, attachments, tools_mode) "
            "values (cast(:i as uuid), cast(:t as uuid), cast(:u as uuid), :c, "
            " cast(:a as jsonb), :m)"
        ),
        {
            "i": new_id,
            "t": thread_id,
            "u": actor_id,
            "c": body,
            "a": json.dumps(attachments or [], ensure_ascii=False),
            "m": tools_mode,
        },
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="chat.message.queue",
            target_type="chat_thread",
            actor_type="user",
            actor_id=str(actor_id),
            target_id=thread_id,
            after={"queued_id": new_id, "chars": len(body)},
        )
    )
    return {
        "id": new_id,
        "content": body,
        "tools_mode": tools_mode,
        "attachments": attachments or [],
    }


async def list_queued(
    session: AsyncSession, *, thread_id: str, actor_id: str
) -> list[dict[str, Any]]:
    """まだ流していない追い足し指示 (古い順)。"""
    thread_id = _uuid_or_error(thread_id, "スレッド")
    res = await session.execute(
        text(
            "select id, content, tools_mode, attachments, created_at "
            "from public.chat_queued_messages "
            "where thread_id = cast(:t as uuid) and requested_by = cast(:u as uuid) "
            "and consumed_at is null order by created_at"
        ),
        {"t": thread_id, "u": actor_id},
    )
    return [
        {
            "id": str(r.id),
            "content": str(r.content),
            "tools_mode": str(r.tools_mode),
            "attachments": _loads(r.attachments),
            "created_at": r.created_at,
        }
        for r in res.all()
    ]


async def consume_next(
    session: AsyncSession, *, thread_id: str, actor_id: str
) -> dict[str, Any] | None:
    """待ちの先頭を 1 件取り出して消費済みにする (無ければ None)。

    `for update skip locked` で二重消費を防ぐ — 同じスレッドを 2 つの画面で
    開いていても、同じ指示が 2 回流れることはない。
    """
    thread_id = _uuid_or_error(thread_id, "スレッド")
    res = await session.execute(
        text(
            "with picked as ("
            "  select id from public.chat_queued_messages "
            "  where thread_id = cast(:t as uuid) and requested_by = cast(:u as uuid) "
            "  and consumed_at is null order by created_at limit 1 for update skip locked"
            ") update public.chat_queued_messages q set consumed_at = now() "
            "where q.id in (select id from picked) "
            "returning q.id, q.content, q.tools_mode, q.attachments"
        ),
        {"t": thread_id, "u": actor_id},
    )
    row = res.first()
    if row is None:
        return None
    return {
        "id": str(row.id),
        "content": str(row.content),
        "tools_mode": str(row.tools_mode),
        "attachments": _loads(row.attachments),
    }


async def consume_next_for_job(session: AsyncSession, *, job_id: str) -> dict[str, Any] | None:
    """GAP-191: 走っているジョブの「追い足し」を 1 件取り出す (Bridge 用)。

    Bridge は job_id しか知らないので、ジョブからスレッドと依頼者を引いて
    `consume_next` に渡す。**実行中の claude へそのまま流し込む**ための入口。

    ジョブが走っていない (完了済み・中断済み) 場合は None — 終わった実行へ
    追い足しを流し込まない (次のターンとして普通に流れる)。
    """
    row = (
        await session.execute(
            text(
                "select thread_id, requested_by, status from public.chat_relay_jobs "
                "where id = cast(:i as uuid)"
            ),
            {"i": job_id},
        )
    ).first()
    if row is None or row.thread_id is None:
        return None
    if str(row.status) != "running":
        return None
    return await consume_next(session, thread_id=str(row.thread_id), actor_id=str(row.requested_by))


async def drop_queued(
    session: AsyncSession, *, thread_id: str, queued_id: str, actor_id: str
) -> bool:
    """待ちの指示を取り消す (流す前に気が変わったとき)。"""
    thread_id = _uuid_or_error(thread_id, "スレッド")
    queued_id = _uuid_or_error(queued_id, "指示")
    res = await session.execute(
        text(
            "delete from public.chat_queued_messages "
            "where id = cast(:i as uuid) and thread_id = cast(:t as uuid) "
            "and requested_by = cast(:u as uuid) and consumed_at is null "
            "returning id"
        ),
        {"i": queued_id, "t": thread_id, "u": actor_id},
    )
    return res.first() is not None


__all__ = [
    "CANCEL_NOTE",
    "MAX_QUEUED_CHARS",
    "MAX_QUEUED_PER_THREAD",
    "ActiveRun",
    "CancelResult",
    "PersistResult",
    "RunControlError",
    "RunSnapshot",
    "active_run",
    "assemble_answer",
    "cancel_requested",
    "consume_next",
    "consume_next_for_job",
    "drop_queued",
    "list_queued",
    "persist_answer",
    "queue_message",
    "request_cancel",
    "run_snapshot",
    "saved_answer",
]
