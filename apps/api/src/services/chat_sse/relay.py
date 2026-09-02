"""GAP-114: チャットのローカル実行リレー — SSE 側アダプタ。

ATELIER_LLM_PROVIDER=relay の opt-in で、S-E01 チャットの LLM 実行を
サーバー内で行わず、ユーザー PC の Bridge (= 本人の Claude プラン) に中継する。

流れ:
    1. Bridge presence (90 秒鮮度) を確認 — 不在なら RelayUnavailable
       (黙って API 課金や fake に落とさない誠実設計)
    2. chat_relay_jobs へ enqueue し即 commit (Bridge の別トランザクション
       から見えるように。SSE 応答の generator 内で長 tx を持たない)
    3. GAP-202: chunk が書き込まれた瞬間に DB から通知を受けて text delta を
       逐次 yield する (待っている間は DB を叩かない。通知が使えない環境では
       従来のポーリング間隔へ自動で戻る)
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

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.db.notify import JobNotifier, job_notifier
from src.db.session import shared_session_factory
from src.services import chat_relay

PROVIDER_ENV = "ATELIER_LLM_PROVIDER"
TIMEOUT_ENV = "ATELIER_CHAT_RELAY_TIMEOUT"

_DEFAULT_TIMEOUT_SECONDS = 180.0


class RelayUnavailable(Exception):
    """Bridge worker がオフライン (presence 鮮度切れ) で中継できない。

    GAP-240: reason で「未接続 (トークン未発行)」と「接続済みだが今は起動していない」を
    区別する — 案内文が別物になる (AI-103)。
    """

    def __init__(self, reason: str = "offline") -> None:
        super().__init__(reason)
        self.reason = reason


class RelayFailed(Exception):
    """Bridge 側の実行が error で確定した。"""


class RelayTimeout(Exception):
    """制限時間内に done/error にならなかった (job は expired 済)。"""


class RelayCancelled(Exception):
    """GAP-189: 人が中断した。失敗ではないので error 扱いにしない。

    そこまでに出た本文は cancel 時にサーバーがスレッドへ保存済み。
    """

    def __init__(self, job_id: str) -> None:
        super().__init__(f"chat relay job {job_id} was cancelled by the user")
        self.job_id = job_id


def relay_mode_enabled() -> bool:
    """本人の PC の Bridge (= 本人の Claude サブスク) で実行するモードか。

    GAP-175: **これが既定**。確定アーキテクチャは「全ユーザーが自分の PC・
    自分の Claude サブスクで実行する」なので、`ATELIER_LLM_PROVIDER` が
    未設定なら relay とみなす。

    以前は `=relay` を明示したときだけ有効で、未設定だと relay を飛ばして
    `ANTHROPIC_API_KEY` (運営の従量課金) に落ちていた — つまり**既定が
    運営課金**という、設計と正反対の状態だった。
    他経路を使いたいときだけ `agent_sdk` / `api` を明示する。
    """
    # GAP-178: 判定は llm_route.resolve_llm_route() 1 か所に集約した
    # (env の「不在」に挙動を依存させない / 打ち間違いは安全側へ倒す)。
    from .llm_route import resolve_llm_route

    return resolve_llm_route().route == "relay"


def relay_mode_explicit() -> bool:
    """`ATELIER_LLM_PROVIDER=relay` を明示指定しているか (既定の relay と区別)。"""
    return os.environ.get(PROVIDER_ENV, "").strip().lower() == "relay"


def _timeout_seconds() -> float:
    raw = os.environ.get(TIMEOUT_ENV, "").strip()
    try:
        value = float(raw)
    except ValueError:
        return _DEFAULT_TIMEOUT_SECONDS
    return value if value > 0 else _DEFAULT_TIMEOUT_SECONDS


def _session_factory() -> async_sessionmaker[AsyncSession]:
    # GAP-197: engine はプロセスに 1 つ (loop ごとに作らない)
    return shared_session_factory()


def service_session_factory() -> async_sessionmaker[AsyncSession]:
    """GAP-189: SSE の外 (ジョブ確定を跨ぐ読み書き) で使う service session factory。

    リクエスト scope の session は SSE の寿命と合わず、Bridge 側の commit を
    跨いで読むには別 session が要る。同一モジュール内の実装を公開名で貸す。
    """
    return _session_factory()


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
    thread_id: str | None,
    actor_id: str,
    tools_mode: str = "off",
) -> AsyncIterator[str | dict[str, object]]:
    """Bridge 中継でイベントを逐次 yield する。

    yield するもの (agent_sdk_stream_chunks と同一形 — SSE 側は共通処理):
      - {"job": job_id}: このターンの実行 ID (GAP-189 — 最初に 1 回だけ)。
        画面はこれで「停止」ボタンを出し、閉じても繋ぎ直せる
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
        # GAP-240: 本人の Bridge だけを見る (他人の Bridge がオンラインでも本人の
        # ジョブは誰にも拾われない)。未接続と未起動は案内を分ける。
        if not await chat_relay.worker_online(session, user_id=actor_id):
            if await chat_relay.user_has_bridge_token(session, user_id=actor_id):
                raise RelayUnavailable("offline")
            raise RelayUnavailable("not_connected")

        # GAP-190: スレッドは「同じ Claude セッション」で走らせる。
        #   - prompt      … 新しい発言だけ (セッションを再開できたとき用)
        #   - prompt_full … 履歴を畳んだもの (再開できなかったとき用)
        # どちらを使うかは **Bridge が PC 上の実ファイルを見て決める**。
        # 再開できたときは履歴を送らないので、利用者のプラン枠を余分に使わない。
        session_id: str | None = None
        if thread_id is not None:
            from src.services.chat_relay.session import ensure_thread_session

            session_id = (await ensure_thread_session(session, thread_id=thread_id)).session_id

        job_id = await chat_relay.enqueue_job(
            session,
            thread_id=thread_id,
            requested_by=actor_id,
            system_prompt=system_prompt,
            prompt=user_message if session_id is not None else fold_prompt(history, user_message),
            tools_mode=tools_mode,
            session_id=session_id,
            prompt_full=(fold_prompt(history, user_message) if session_id is not None else None),
        )
        await session.commit()

    # GAP-189: 実行 ID を先に渡す。これが無いと画面から中断できず、
    # 画面を閉じたときに「どの実行に繋ぎ直せばいいか」も分からない。
    yield {"job": job_id}

    # PC 操作 (approve/auto) は複数ターンのツール実行 + ユーザー承認待ちを含む
    # ため、既定タイムアウトを長めに取る (env 明示があればそちらを尊重)。
    timeout = _timeout_seconds()
    if tools_mode in ("approve", "auto") and not os.environ.get(TIMEOUT_ENV, "").strip():
        timeout = max(timeout, 600.0)

    deadline = asyncio.get_event_loop().time() + timeout
    last_seq = -1
    seen_approvals: dict[str, str] = {}  # id -> 最後に配信した decision

    # GAP-202: 0.25 秒ごとに「届いた？」と聞きに行くのをやめ、**書き込まれた
    # 瞬間に起こしてもらう**。待っている人数ぶん DB を叩いていたのが、
    # 動きがあったときだけになる (待機は運営サーバーの負荷にならない)。
    # 通知が張れない / 落ちている間は従来のポーリング間隔へ自動で戻るので、
    # 黙って固まることはない。
    notifier = await job_notifier()
    with notifier.subscribe(job_id) as wake:
        async for event in _relay_events(
            notifier=notifier,
            wake=wake,
            factory=factory,
            job_id=job_id,
            tools_mode=tools_mode,
            timeout=timeout,
            deadline=deadline,
            last_seq=last_seq,
            seen_approvals=seen_approvals,
        ):
            yield event


async def _relay_events(
    *,
    notifier: JobNotifier,
    wake: asyncio.Event,
    factory: async_sessionmaker[AsyncSession],
    job_id: str,
    tools_mode: str,
    timeout: float,
    deadline: float,
    last_seq: int,
    seen_approvals: dict[str, str],
) -> AsyncIterator[str | dict[str, object]]:
    """通知で起きて差分を配る本体 (GAP-202 で poll ループから切り出した)。"""
    while True:
        # 通知が来たら即座に、来なければ保険の間隔で起きる。
        await notifier.wait(wake)
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
        if status == "cancelled":
            # GAP-189: 人が止めた。エラーメッセージを出さず、静かに終える
            # (ここまでの本文は cancel 時にサーバーが保存済み)。
            raise RelayCancelled(job_id)
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
