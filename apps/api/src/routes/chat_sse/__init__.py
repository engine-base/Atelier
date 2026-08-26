"""チャット SSE ストリーミング + F-CTX01 文脈構築 ルータ (T-A-18)。

S-E01 チャット画面用。POST /chat/threads/{thread_id}/stream で
user_message を受け、F-CTX01 (過去 message + ナレッジ RAG) を構築した
system prompt で LLM 応答を SSE (text/event-stream) で配信する。

認証 (401) + RLS (T-D-17 chat_threads) + 404。stream 中の各イベントは
JSON で encode、Content-Type: text/event-stream で配信。
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Annotated, NoReturn

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.rate_limit import rate_limit_user
from src.schemas.chat_sse import (
    ChatContextPreviewRequest,
    ChatContextPreviewResponse,
    ChatQueuedMessageRequest,
    ChatQueuedMessageResponse,
    ChatRunCancelResponse,
    ChatRunResponse,
    ChatStreamRequest,
    PcApprovalDecisionRequest,
    PcApprovalDecisionResponse,
)
from src.services import chat_run as run_svc
from src.services import chat_sse as svc
from src.services.chat_sse import capacity, pc_approvals
from src.user_messages import user_detail

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import async_sessionmaker

router = APIRouter(tags=["chat-sse"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


def _run_session() -> AsyncSession:
    """GAP-189: 実行制御用の service session。

    chat_relay_jobs / chat_queued_messages は本人の行しか触らないが、RLS 経路の
    session は SSE やジョブ確定を跨いだ読み書きに使えないため service 経路を使う
    (本人性はサービス層で requested_by 照合により担保する)。
    """
    from src.services.chat_sse.relay import service_session_factory

    factory: async_sessionmaker[AsyncSession] = service_session_factory()
    return factory()


async def _thread_visible(session: AsyncSession, thread_id: str) -> bool:
    res = await session.execute(
        text(
            "select 1 from public.chat_threads where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": thread_id},
    )
    return res.first() is not None


# --------------------------------------------------------------------------- #
# GAP-198 / GAP-203: SSE の同時本数を守る。
#
# GAP-198 では上限に当たったら即 503 にしていた。だが上限は「同時に**実行**
# できる数」であって「受け付けられない数」ではない。503 にすると利用者は
# **打った文章ごと弾き返される** — 混雑がそのまま故障に見える。
#
# GAP-203: **断らずに並んでもらう**。並んでいる間は「順番待ち N 番目」を
# SSE で流し続け、空き次第そのまま実行に入る。列まで一杯 / 待たせすぎのときだけ
# 正直に断る (そのときも日本語で理由を返す)。
# --------------------------------------------------------------------------- #
BUSY_MESSAGE = (
    "ただいま大変混み合っています。時間をおいてもう一度お試しください。"
    "（お客様の文章は消えていません）"
)


def _sse(payload: dict[str, object]) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


def guarded_stream(
    generator: AsyncIterator[bytes],
) -> StreamingResponse:
    """SSE を 1 本ぶん確保してから返す (切断されても必ず返却する)。

    空いていれば今までどおり即座に流れる。混んでいるときだけ、先に
    `queued` イベントを流しながら順番を待つ。
    """

    async def _wrapped() -> AsyncIterator[bytes]:
        started: float | None = None
        holding = False
        # **明示的に持っておく**: 順番待ちの最中に画面を閉じられると、この
        # generator は GeneratorExit で畳まれる。そのとき `async for` の中の
        # generator は自動では閉じられない (GC 任せ) ので、列に並んだままになり
        # **席が戻らない**。実 e2e で踏んだ。finally で必ず閉じる。
        waiter = capacity.wait_for_slot()
        try:
            try:
                async for update in waiter:
                    yield _sse(
                        {
                            "type": "queued",
                            "metadata": {
                                "position": update.position,
                                "ahead": update.ahead,
                                # 材料が無いうちは null (根拠の無い秒数を出さない)
                                "eta_seconds": (
                                    None
                                    if update.eta_seconds is None
                                    else round(update.eta_seconds)
                                ),
                            },
                        }
                    )
            except capacity.StreamCapacityExceeded:
                # ここまで来たら本文は 1 バイトも流していない場合もあるが、
                # SSE として **理由を本文で返す** (画面が読める形にする)。
                yield _sse({"type": "error", "content": BUSY_MESSAGE})
                return
            finally:
                await waiter.aclose()

            holding = True
            started = time.monotonic()
            async for chunk in generator:
                yield chunk
        finally:
            if holding:
                if started is not None:
                    # 次の人へ出す「待ち時間の目安」の材料 (実測)。
                    capacity.record_duration(time.monotonic() - started)
                capacity.release()

    return StreamingResponse(
        _wrapped(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post(
    "/chat/threads/{thread_id}/stream",
    dependencies=[Depends(rate_limit_user(30))],  # x-rate-limit: 30/min/user
    summary="チャット SSE ストリーミング (F-CTX01 文脈構築 + LLM)",
)
async def stream_chat_thread(
    thread_id: str,
    body: ChatStreamRequest,
    session: SessionDep,
    user: UserDep,
) -> StreamingResponse:
    if not await _thread_visible(session, thread_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の会話が見つかりません。")
    # GAP-001: 添付の storage_path は本スレッド配下のみ許可 (他スレッド添付の
    # 参照持ち込み = 可視性バイパスを拒否)
    for att in body.attachments:
        if not att.storage_path.startswith(f"chat-attachments/{thread_id}/"):
            # GAP-225: 英語だったうえ、**送られてきたファイル名をそのまま返して
            # いた** (GAP-222 と同じ、入力のエコーバック)。何が拒まれたかは
            # サーバーログにだけ残す。
            logger.warning("attachment outside thread %s rejected", thread_id)
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "この会話に属さない添付は送信できません。",
            )
    gen = svc.stream_chat(
        session,
        actor_id=user.id,
        thread_id=thread_id,
        user_message=body.user_message,
        use_rag=body.use_knowledge_rag,
        include_history=body.include_history,
        rag_account_id=body.rag_account_id,
        attachments=[att.model_dump() for att in body.attachments],
        tools_mode=body.tools_mode,
    )
    return guarded_stream(gen)


@router.post(
    "/chat/pc-approvals/{approval_id}",
    dependencies=[Depends(rate_limit_user(60))],  # x-rate-limit: 60/min/user
    summary="PC 操作 (approve モード) の承認カードに許可/拒否を返す (GAP-130)",
)
async def resolve_pc_approval(
    approval_id: str,
    body: PcApprovalDecisionRequest,
    user: UserDep,
) -> dict[str, PcApprovalDecisionResponse]:
    """SSE の pc_approval カードで提示した実行を許可/拒否する。

    2 系統を同じ入口で解決する (フロントは経路を意識しない):
      1. agent_sdk: プロセス内レジストリ (サーバー内実行)
      2. relay (GAP-134): chat_relay_approvals 行 (本人の PC の Bridge が
         ポーリングで決定を読む)。本人の job に紐づく pending のみ更新可。
    未知 ID・他ユーザーの ID・解決済みは 404 (存在を漏らさない)。
    """
    ok = pc_approvals.resolve_request(approval_id, user_id=user.id, decision=body.decision)
    if not ok:
        from src.services import chat_relay as relay_svc
        from src.services.project_credentials import (
            _service_session_factory,  # pyright: ignore[reportPrivateUsage]
        )

        async with _service_session_factory()() as svc_session:
            ok = await relay_svc.resolve_approval_for_user(
                svc_session,
                approval_id=approval_id,
                user_id=user.id,
                decision=body.decision,
            )
            if ok:
                await svc_session.commit()
    if not ok:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "対象のパソコン操作の承認依頼が見つかりません。"
        )
    return {"data": PcApprovalDecisionResponse(resolved=True)}


@router.post(
    "/chat/threads/{thread_id}/context-preview",
    summary="チャット F-CTX01 文脈構築プレビュー (LLM 呼出無し)",
)
async def preview_chat_context(
    thread_id: str,
    body: ChatContextPreviewRequest,
    session: SessionDep,
    _user: UserDep,
) -> dict[str, ChatContextPreviewResponse]:
    if not await _thread_visible(session, thread_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の会話が見つかりません。")
    return {
        "data": await svc.preview_context(
            session,
            thread_id=thread_id,
            user_message=body.user_message,
            include_history=body.include_history,
            rag_account_id=body.rag_account_id,
        )
    }


# ── GAP-189: 実行の制御 — 中断 / 追い足し指示 / 繋ぎ直し ───────────────
#
# 経営者指摘「中断とか入ってないけど、これ Claude だとできるけど」
#           「止まっても裏のターミナルは変わらないんでしょ？ だったら続けてと
#             かで自動で後ろは繋がるよね？」
#
# 本人性の検証 (requested_by 照合) は services/chat_run 側で行う。ここは
# HTTP 表現への変換のみ。


def _raise_run_error(exc: run_svc.RunControlError) -> NoReturn:
    code = {
        "not_found": status.HTTP_404_NOT_FOUND,
        "forbidden": status.HTTP_403_FORBIDDEN,
        "invalid_state": status.HTTP_409_CONFLICT,
        "too_many": status.HTTP_409_CONFLICT,
    }.get(exc.code, status.HTTP_400_BAD_REQUEST)
    raise HTTPException(code, user_detail(exc))


@router.get(
    "/chat/threads/{thread_id}/run",
    summary="このスレッドで今走っている実行 (GAP-189)",
)
async def get_active_run(
    thread_id: str, session: SessionDep, user: UserDep
) -> dict[str, ChatRunResponse]:
    """画面を開き直したときに「まだ走っている」と分かるようにする。

    job_id が返ったら、そのまま `/chat/runs/{job_id}/attach` に繋ぎ直せる。
    """
    if not await _thread_visible(session, thread_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の会話が見つかりません。")
    async with _run_session() as s:
        active = await run_svc.active_run(s, thread_id=thread_id, actor_id=user.id)
    if active is None:
        return {"data": ChatRunResponse()}
    return {
        "data": ChatRunResponse(
            job_id=active.job_id,
            status=active.status,
            tools_mode=active.tools_mode,
            started_at=None if active.started_at is None else active.started_at.isoformat(),
        )
    }


@router.post(
    "/chat/runs/{job_id}/cancel",
    dependencies=[Depends(rate_limit_user(60))],  # x-rate-limit: 60/min/user
    summary="走っている実行を止める (GAP-189)",
)
async def cancel_run(job_id: str, user: UserDep) -> dict[str, ChatRunCancelResponse]:
    """人が押した中断。**PC 上の claude も実際に止まる**。

    クラウドの状態を落とすだけで本人の PC では走り続ける、という嘘の中断には
    しない (Bridge が状態を見て子プロセスを kill する)。そこまでに出ていた
    本文は捨てずにスレッドへ残す。
    """
    async with _run_session() as s:
        try:
            result = await run_svc.request_cancel(s, job_id=job_id, actor_id=user.id)
        except run_svc.RunControlError as exc:
            await s.rollback()
            _raise_run_error(exc)
        await s.commit()
    return {
        "data": ChatRunCancelResponse(
            status=result.status,  # pyright: ignore[reportArgumentType]
            message=result.message,
            assistant_message_id=result.assistant_message_id,
            saved_chars=result.saved_chars,
        )
    }


@router.get(
    "/chat/runs/{job_id}/attach",
    summary="走っている実行に繋ぎ直す SSE (GAP-189)",
)
async def attach_run(job_id: str, user: UserDep) -> StreamingResponse:
    """画面を閉じても PC は仕事を続けている。戻ってきたら最初から見せ直す。

    DB に溜まった chunk を先頭から流し、その後は追いつきながら中継する。
    イベント形は通常のストリームと同じなので、画面側は同じパーサで読める。
    """
    return guarded_stream(svc.attach_run(job_id=job_id, actor_id=user.id))


@router.get(
    "/chat/threads/{thread_id}/queued",
    summary="まだ流していない追い足し指示 (GAP-189)",
)
async def list_queued_messages(
    thread_id: str, session: SessionDep, user: UserDep
) -> dict[str, list[ChatQueuedMessageResponse]]:
    if not await _thread_visible(session, thread_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の会話が見つかりません。")
    async with _run_session() as s:
        items = await run_svc.list_queued(s, thread_id=thread_id, actor_id=user.id)
    return {
        "data": [
            ChatQueuedMessageResponse(
                id=str(i["id"]),
                content=str(i["content"]),
                tools_mode=str(i["tools_mode"]),
                created_at=(None if i["created_at"] is None else i["created_at"].isoformat()),
            )
            for i in items
        ]
    }


@router.post(
    "/chat/threads/{thread_id}/queued",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(rate_limit_user(60))],  # x-rate-limit: 60/min/user
    summary="実行中でも指示を送れるようにする (GAP-189)",
)
async def queue_message(
    thread_id: str,
    body: ChatQueuedMessageRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, ChatQueuedMessageResponse]:
    """実行中に送られた指示を**受け取った瞬間に保存**する。

    ここで保存するので、この後ブラウザが落ちても指示は消えない。今の実行が
    終わったら consume で順に取り出して普通の 1 ターンとして流す。
    """
    if not await _thread_visible(session, thread_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の会話が見つかりません。")
    async with _run_session() as s:
        try:
            item = await run_svc.queue_message(
                s,
                thread_id=thread_id,
                actor_id=user.id,
                content=body.content,
                tools_mode=body.tools_mode,
            )
        except run_svc.RunControlError as exc:
            await s.rollback()
            _raise_run_error(exc)
        await s.commit()
    return {
        "data": ChatQueuedMessageResponse(
            id=str(item["id"]), content=str(item["content"]), tools_mode=str(item["tools_mode"])
        )
    }


@router.post(
    "/chat/threads/{thread_id}/queued/consume",
    summary="待ちの指示を 1 件取り出す (GAP-189)",
)
async def consume_queued_message(
    thread_id: str, session: SessionDep, user: UserDep
) -> dict[str, ChatQueuedMessageResponse | None]:
    """実行が終わった画面が次に流す 1 件を取り出す (無ければ null)。

    `for update skip locked` で二重消費を防ぐ — 同じスレッドを 2 つの画面で
    開いていても、同じ指示が 2 回流れることはない。
    """
    if not await _thread_visible(session, thread_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の会話が見つかりません。")
    async with _run_session() as s:
        item = await run_svc.consume_next(s, thread_id=thread_id, actor_id=user.id)
        await s.commit()
    if item is None:
        return {"data": None}
    return {
        "data": ChatQueuedMessageResponse(
            id=str(item["id"]), content=str(item["content"]), tools_mode=str(item["tools_mode"])
        )
    }


@router.delete(
    "/chat/threads/{thread_id}/queued/{queued_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="待ちの指示を取り消す (GAP-189)",
)
async def drop_queued_message(
    thread_id: str, queued_id: str, session: SessionDep, user: UserDep
) -> None:
    if not await _thread_visible(session, thread_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の会話が見つかりません。")
    async with _run_session() as s:
        try:
            removed = await run_svc.drop_queued(
                s, thread_id=thread_id, queued_id=queued_id, actor_id=user.id
            )
        except run_svc.RunControlError as exc:
            await s.rollback()
            _raise_run_error(exc)
        await s.commit()
    if not removed:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "順番待ちのメッセージが見つかりません。")
