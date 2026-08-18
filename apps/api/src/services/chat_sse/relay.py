"""GAP-114: チャットのローカル実行リレー — SSE 側アダプタ。

ATELIER_LLM_PROVIDER=relay の opt-in で、S-E01 チャットの LLM 実行を
サーバー内で行わず、ユーザー PC の Bridge (= 本人の Claude プラン) に中継する。

流れ:
    1. Bridge presence (90 秒鮮度) を確認 — 不在なら RelayUnavailable
       (黙って API 課金や fake に落とさない誠実設計)
    2. chat_relay_jobs へ enqueue し即 commit (Bridge の別トランザクション
       から見えるように。SSE 応答の generator 内で長 tx を持たない)
    3. chunks をポーリング (0.25s) して text delta を逐次 yield
    4. done で完走 / error で RelayFailed / タイムアウトで expire + RelayTimeout

このモジュールは自前の session factory を持つ (リクエストスコープの
session は SSE の寿命と合わず、Bridge の書き込みを見るには commit 済み
データを跨いで読む必要があるため — routes/dispatcher と同じ方式)。
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from functools import lru_cache

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.db.session import create_engine, create_session_factory
from src.services import chat_relay

PROVIDER_ENV = "ATELIER_LLM_PROVIDER"
TIMEOUT_ENV = "ATELIER_CHAT_RELAY_TIMEOUT"

_DEFAULT_TIMEOUT_SECONDS = 180.0
_POLL_INTERVAL_SECONDS = 0.25


class RelayUnavailable(Exception):
    """Bridge worker がオフライン (presence 鮮度切れ) で中継できない。"""


class RelayFailed(Exception):
    """Bridge 側の実行が error で確定した。"""


class RelayTimeout(Exception):
    """制限時間内に done/error にならなかった (job は expired 済)。"""


def relay_mode_enabled() -> bool:
    """ATELIER_LLM_PROVIDER=relay の明示 opt-in か。"""
    return os.environ.get(PROVIDER_ENV, "").strip().lower() == "relay"


def _timeout_seconds() -> float:
    raw = os.environ.get(TIMEOUT_ENV, "").strip()
    try:
        value = float(raw)
    except ValueError:
        return _DEFAULT_TIMEOUT_SECONDS
    return value if value > 0 else _DEFAULT_TIMEOUT_SECONDS


@lru_cache(maxsize=1)
def _session_factory() -> async_sessionmaker[AsyncSession]:
    return create_session_factory(create_engine())


async def record_plan_observations(user_id: str, observations: list[dict[str, object]]) -> None:
    """GAP-124: agent_sdk 経路の RateLimitEvent 観測値を本人へ記録する。

    ベストエフォート (失敗してもチャット応答は既に返っている)。
    書き込みは service session (chat_plan_status は RLS default deny)。
    """
    if not observations:
        return
    factory = _session_factory()
    async with factory() as session:
        await chat_relay.record_plan_status_for_user(
            session, user_id=user_id, observations=list(observations)
        )
        await session.commit()


async def relay_stream_chunks(
    *,
    system_prompt: str,
    history: list[tuple[str, str]],
    user_message: str,
    thread_id: str,
    actor_id: str,
    tools_mode: str = "off",
) -> AsyncIterator[str | dict[str, object]]:
    """Bridge 中継でイベントを逐次 yield する。

    yield するもの (agent_sdk_stream_chunks と同一形 — SSE 側は共通処理):
      - str: 応答本文の text delta
      - {"tool": name}: ツール実行の実況 (GAP-134)
      - {"pc_approval": {...}} / {"pc_approval_resolved": {...}}: 承認カード
        (Bridge が CLI の許可要求を DB に積み、ここで検知して配信する)

    presence 不在は最初の yield 前に RelayUnavailable を raise する
    (呼び出し側が SSE error に変換する)。
    """
    from .agent_sdk import fold_prompt  # 履歴の畳み込みはサブスク経路と同一仕様

    factory = _session_factory()

    async with factory() as session:
        if not await chat_relay.worker_online(session):
            raise RelayUnavailable
        job_id = await chat_relay.enqueue_job(
            session,
            thread_id=thread_id,
            requested_by=actor_id,
            system_prompt=system_prompt,
            prompt=fold_prompt(history, user_message),
            tools_mode=tools_mode,
        )
        await session.commit()

    # PC 操作 (approve/auto) は複数ターンのツール実行 + ユーザー承認待ちを含む
    # ため、既定タイムアウトを長めに取る (env 明示があればそちらを尊重)。
    timeout = _timeout_seconds()
    if tools_mode in ("approve", "auto") and not os.environ.get(TIMEOUT_ENV, "").strip():
        timeout = max(timeout, 600.0)

    deadline = asyncio.get_event_loop().time() + timeout
    last_seq = -1
    seen_approvals: dict[str, str] = {}  # id -> 最後に配信した decision
    while True:
        await asyncio.sleep(_POLL_INTERVAL_SECONDS)
        async with factory() as session:
            chunks = await chat_relay.fetch_chunks(session, job_id=job_id, after_seq=last_seq)
            status, error = await chat_relay.job_result(session, job_id=job_id)
            approvals = (
                await chat_relay.list_job_approvals(session, job_id=job_id)
                if tools_mode == "approve"
                else []
            )
        for seq, kind, content in chunks:
            last_seq = seq
            if not content:
                continue
            if kind == "tool":
                yield {"tool": content}
            elif kind == "artifact":
                # GAP-137: 成果物のモック取り込み結果 (JSON) — 壊れた行は捨てる
                try:
                    payload = json.loads(content)
                except ValueError:
                    continue
                if isinstance(payload, dict):
                    yield {"artifact": payload}
            else:
                yield content
        for ap in approvals:
            prev = seen_approvals.get(ap["id"])
            if prev is None and ap["decision"] == "pending":
                seen_approvals[ap["id"]] = "pending"
                yield {
                    "pc_approval": {
                        "id": ap["id"],
                        "tool": ap["tool"],
                        "summary": ap["summary"],
                    }
                }
            elif prev == "pending" and ap["decision"] != "pending":
                seen_approvals[ap["id"]] = ap["decision"]
                yield {"pc_approval_resolved": {"id": ap["id"], "decision": ap["decision"]}}
        if status == "done":
            return
        if status == "error":
            raise RelayFailed(error or "ローカル実行がエラーで終了しました")
        if status == "expired":
            raise RelayTimeout
        if asyncio.get_event_loop().time() > deadline:
            async with factory() as session:
                await chat_relay.expire_job(
                    session, job_id=job_id, reason=f"SSE timeout ({timeout:.0f}s)"
                )
                await session.commit()
            raise RelayTimeout
