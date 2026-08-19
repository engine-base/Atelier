"""Hermes 互換 kanban_tools ルータ (T-A-28)。

Bridge worker (F-BRIDGE01) からの 7 ツール HTTP endpoint。
X-Bridge-Token ヘッダで認証 (Supabase JWT とは独立)。トークン一致時は
service_role 相当のフルアクセスセッションを払い出し、RLS をバイパスする
(worker は全 workspace の queued task に到達する必要がある)。

7 endpoint:
- POST /kanban/pick            : queued task 確保 → spawning
- POST /kanban/start           : spawning → running
- POST /kanban/complete        : running → done|awaiting (Hermes 既存)
- POST /kanban/request-review  : running → awaiting
- POST /kanban/request-change  : running → blocked
- POST /kanban/heartbeat       : worker heartbeat (PID dead-man switch)
- POST /kanban/kill            : 強制終了 → reclaimed
"""

from __future__ import annotations

import hmac
import os
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated, NoReturn

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.db.session import create_engine, create_session_factory
from src.schemas.dispatcher import (
    ChatRelayApprovalCreateRequest,
    ChatRelayApprovalCreateResponse,
    ChatRelayApprovalStatusResponse,
    ChatRelayArtifactItem,
    ChatRelayArtifactResult,
    ChatRelayArtifactsRequest,
    ChatRelayChunksRequest,
    ChatRelayCompleteRequest,
    ChatRelayPickRequest,
    ChatRelayPickResponse,
    KanbanCompleteRequest,
    KanbanHeartbeatRequest,
    KanbanKillRequest,
    KanbanPickRequest,
    KanbanPickResponse,
    KanbanRequestChangeRequest,
    KanbanRequestReviewRequest,
    KanbanResponse,
    KanbanStartRequest,
)
from src.schemas.executions import BridgePingRequest
from src.services import chat_relay as relay_svc
from src.services.chat_relay import ChatRelayError
from src.services.dispatcher import bridge_tools as svc

router = APIRouter(tags=["kanban-tools"])


@lru_cache(maxsize=1)
def _bridge_session_factory() -> async_sessionmaker[AsyncSession]:
    return create_session_factory(create_engine())


@dataclass(frozen=True)
class BridgeIdentity:
    """Bridge 認証の主体 (GAP-122)。

    - kind='instance': ATELIER_BRIDGE_TOKEN (インスタンス共通) — 全権
    - kind='user': ユーザー別トークン — chat-relay (本人の job のみ) + ping 限定
    """

    kind: str  # 'instance' | 'user'
    user_id: str | None = None


async def get_bridge_session() -> AsyncGenerator[AsyncSession, None]:
    """Bridge worker 向け service_role 相当の AsyncSession を払い出す。

    RLS バイパス (role を下げない)。例外時 rollback、正常時 commit。
    test では本依存のみを override し token 検証は経路通りに走らせる。
    """
    factory = _bridge_session_factory()
    async with factory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        else:
            await session.commit()


BridgeSession = Annotated[AsyncSession, Depends(get_bridge_session)]


async def verify_bridge_token(
    session: BridgeSession,
    x_bridge_token: Annotated[str | None, Header()] = None,
) -> BridgeIdentity:
    """X-Bridge-Token を照合する (GAP-122 で二段化)。

    1. ATELIER_BRIDGE_TOKEN と一致 → インスタンス トークン (全権)
    2. bridge_user_tokens の有効トークン → ユーザー トークン
       (chat-relay 本人分 + ping のみ。kanban 系は 403)
    どちらにも一致しなければ 401。

    GAP-169: **ユーザー トークンの検証はインスタンス トークンの設定有無に
    依存させない**。以前は ATELIER_BRIDGE_TOKEN 未設定を 500 で弾いていたため、
    画面 (GAP-122 の接続フロー) から発行した本人トークンで Bridge を繋ごうと
    すると、運営がその環境変数を入れていない環境では全員 500 になっていた
    (= 接続フローを出しても繋がらない)。インスタンス トークンは kanban /
    タスク実行系のための任意設定であり、本人の PC を繋ぐのに必須ではない。
    """
    if not x_bridge_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid bridge token")
    expected = os.environ.get("ATELIER_BRIDGE_TOKEN")
    if expected and hmac.compare_digest(x_bridge_token, expected):
        return BridgeIdentity(kind="instance")
    from src.services import bridge_tokens as user_tokens_svc

    user_id = await user_tokens_svc.verify_user_token(session, raw=x_bridge_token)
    if user_id is not None:
        return BridgeIdentity(kind="user", user_id=user_id)
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid bridge token")


BridgeAuth = Annotated[BridgeIdentity, Depends(verify_bridge_token)]


def _require_instance(identity: BridgeIdentity) -> None:
    """タスク実行系はインスタンス トークン限定 (ユーザー トークンに過剰権限を与えない)。"""
    if identity.kind != "instance":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "このトークンはチャット接続専用です (タスク実行はインスタンス トークンが必要)",
        )


def _raise_for(code: str, message: str) -> NoReturn:
    if code == "not_found":
        raise HTTPException(status.HTTP_404_NOT_FOUND, message)
    if code == "invalid_state":
        raise HTTPException(status.HTTP_409_CONFLICT, message)
    raise HTTPException(status.HTTP_400_BAD_REQUEST, message)


@router.post("/kanban/pick", summary="kanban_pick (Hermes 互換)")
async def kanban_pick(
    body: KanbanPickRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanPickResponse]:
    _require_instance(_token)
    result, exec_id, wt, task_context = await svc.pick_task(
        session, worker_pid=body.worker_pid, project_id=body.project_id
    )
    if result is None:
        return {"data": KanbanPickResponse(no_available_task=True)}
    return {
        "data": KanbanPickResponse(
            task_id=result.task_id,
            execution_id=exec_id,
            worktree_path=wt,
            no_available_task=False,
            task_title=task_context.get("title"),
            task_description=task_context.get("description"),
            assigned_employee=task_context.get("assigned_employee"),
        )
    }


@router.post("/kanban/start", summary="kanban_start (Hermes 互換)")
async def kanban_start(
    body: KanbanStartRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanResponse]:
    _require_instance(_token)
    try:
        result = await svc.start_task(
            session,
            task_id=body.task_id,
            execution_id=body.execution_id,
            worker_pid=body.worker_pid,
            claude_code_session_id=body.claude_code_session_id,
        )
    except svc.DispatcherError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": result}


@router.post("/kanban/complete", summary="kanban_complete (Hermes 互換)")
async def kanban_complete(
    body: KanbanCompleteRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanResponse]:
    _require_instance(_token)
    try:
        result = await svc.complete_task(
            session,
            task_id=body.task_id,
            execution_id=body.execution_id,
            summary=body.summary,
            metadata=body.metadata,
            auto_approve=body.auto_approve,
        )
    except svc.DispatcherError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": result}


@router.post("/kanban/request-review", summary="kanban_request_review (Hermes 互換)")
async def kanban_request_review(
    body: KanbanRequestReviewRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanResponse]:
    _require_instance(_token)
    try:
        result = await svc.request_review(
            session,
            task_id=body.task_id,
            execution_id=body.execution_id,
            note=body.note,
        )
    except svc.DispatcherError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": result}


@router.post("/kanban/request-change", summary="kanban_request_change (Hermes 互換)")
async def kanban_request_change(
    body: KanbanRequestChangeRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanResponse]:
    _require_instance(_token)
    try:
        result = await svc.request_change(
            session,
            task_id=body.task_id,
            execution_id=body.execution_id,
            reason=body.reason,
        )
    except svc.DispatcherError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": result}


@router.post("/kanban/heartbeat", summary="kanban_heartbeat (dead-man switch)")
async def kanban_heartbeat(
    body: KanbanHeartbeatRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanResponse]:
    _require_instance(_token)
    try:
        result = await svc.heartbeat(session, task_id=body.task_id, worker_pid=body.worker_pid)
    except svc.DispatcherError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": result}


@router.post("/kanban/kill", summary="kanban_kill (強制終了)")
async def kanban_kill(
    body: KanbanKillRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanResponse]:
    _require_instance(_token)
    try:
        result = await svc.kill_task(
            session,
            task_id=body.task_id,
            execution_id=body.execution_id,
            reason=body.reason,
        )
    except svc.DispatcherError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": result}


@router.post("/bridge/ping", summary="Bridge presence 登録 (GAP-026① / BridgeAuth)")
async def bridge_ping(
    body: BridgePingRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, dict[str, str]]:
    """Bridge アプリが poll ごとに送る presence。S-I03 の接続バッジの実体。"""
    await svc.record_ping(
        session,
        worker_id=body.worker_id,
        host_label=body.host_label,
        version=body.version,
        worker_pid=body.worker_pid,
        user_id=_token.user_id,
    )
    return {"data": {"status": "ok"}}


# ── GAP-114: チャットのローカル実行リレー (BridgeAuth) ────────────


@router.post("/chat-relay/pick", summary="chat relay job 確保 (GAP-114 / BridgeAuth)")
async def chat_relay_pick(
    body: ChatRelayPickRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, ChatRelayPickResponse]:
    """queued なチャット中継ジョブを 1 件 claim する (queued→running)。"""
    picked = await relay_svc.pick_job(
        session, worker_id=body.worker_id, requested_by=_token.user_id
    )
    if picked is None:
        return {"data": ChatRelayPickResponse(no_available_job=True)}
    return {
        "data": ChatRelayPickResponse(
            job_id=picked["job_id"],
            system_prompt=picked["system_prompt"],
            prompt=picked["prompt"],
            tools_mode=picked["tools_mode"],
        )
    }


@router.post(
    "/chat-relay/{job_id}/chunks",
    summary="chat relay text delta 追記 (GAP-114 / BridgeAuth)",
)
async def chat_relay_chunks(
    job_id: str, body: ChatRelayChunksRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, dict[str, str]]:
    """running ジョブへ text delta を追記する (SSE 側がポーリングで中継)。"""
    try:
        await relay_svc.append_chunks(
            session,
            job_id=job_id,
            seq_start=body.seq_start,
            texts=body.texts,
            kinds=list(body.kinds) if body.kinds is not None else None,
        )
    except ChatRelayError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": {"status": "ok"}}


@router.post(
    "/chat-relay/{job_id}/approvals",
    summary="chat relay PC 操作の承認要求 (GAP-134 / BridgeAuth)",
)
async def chat_relay_create_approval(
    job_id: str,
    body: ChatRelayApprovalCreateRequest,
    session: BridgeSession,
    _token: BridgeAuth,
) -> dict[str, ChatRelayApprovalCreateResponse]:
    """Bridge が CLI の許可要求を承認キューへ積む (SSE が承認カードとして配信)。"""
    try:
        approval_id = await relay_svc.create_approval(
            session, job_id=job_id, tool=body.tool, summary=body.summary
        )
    except ChatRelayError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": ChatRelayApprovalCreateResponse(approval_id=approval_id)}


@router.get(
    "/chat-relay/{job_id}/approvals/{approval_id}",
    summary="chat relay PC 操作の承認決定を取得 (GAP-134 / BridgeAuth)",
)
async def chat_relay_approval_status(
    job_id: str,
    approval_id: str,
    session: BridgeSession,
    _token: BridgeAuth,
) -> dict[str, ChatRelayApprovalStatusResponse]:
    """Bridge がポーリングする決定 (pending のうちは実行を待つ)。"""
    try:
        decision = await relay_svc.approval_decision(
            session, job_id=job_id, approval_id=approval_id
        )
    except ChatRelayError as exc:
        _raise_for(exc.code, exc.message)
    return {
        "data": ChatRelayApprovalStatusResponse(decision=decision)  # type: ignore[arg-type]
    }


@router.get(
    "/chat-relay/{job_id}/workspace",
    summary="chat relay ツールジョブの作業場シード (GAP-141 / BridgeAuth)",
    # GAP-169: 使わない側 (html / content_b64) は null ではなく省略して返す。
    # 受け手が null を「値あり」と誤読して落ちるのを契約側で防ぐ。
    response_model_exclude_none=True,
)
async def chat_relay_workspace_seed(
    job_id: str,
    session: BridgeSession,
    _token: BridgeAuth,
) -> dict[str, list[ChatRelayArtifactItem]]:
    """ジョブの project の最新版 (モック + mockdb 成果物) を返す。

    Bridge が CLI 起動前にローカル作業フォルダへ上書き展開する — ローカルは
    常に「正本のチェックアウト」になり、古いファイルを土台にした編集
    (版連鎖の乱れ) を防ぐ。user トークンは本人のジョブのみ。
    """
    try:
        files = await relay_svc.get_job_workspace_seed(
            session, job_id=job_id, requester_user_id=_token.user_id
        )
    except ChatRelayError as exc:
        _raise_for(exc.code, exc.message)
    # GAP-169: seed には HTML (モック/mockdb 成果物) と base64 (添付・ファイル
    # 成果物 — GAP-161/166) の 2 種類が混ざる。html 決め打ちで組み立てていたため
    # base64 の項目が 1 つでも混ざると KeyError で 500 になり、**作業場 seed 全体が
    # 配られなかった** (= Excel/PDF が本人の PC に届かず GAP-166 が成立しない)。
    return {
        "data": [
            ChatRelayArtifactItem(
                file_name=f["file_name"],
                html=f.get("html"),
                content_b64=f.get("content_b64"),
            )
            for f in files
        ]
    }


@router.post(
    "/chat-relay/{job_id}/artifacts",
    summary="chat relay PC 操作の成果物送信 → モック取り込み (GAP-137 / BridgeAuth)",
)
async def chat_relay_artifacts(
    job_id: str,
    body: ChatRelayArtifactsRequest,
    session: BridgeSession,
    _token: BridgeAuth,
) -> dict[str, list[ChatRelayArtifactResult]]:
    """Bridge がジョブ完了直前に成果物 (HTML) を送る。

    thread の project のモックとして取り込み (同名画面は新バージョン連鎖)、
    kind='artifact' の chunk を積む — SSE が「モック保存」カードとして配信する。
    user トークンは本人のジョブのみ (requested_by 照合)。
    """
    try:
        results = await relay_svc.save_job_artifacts(
            session,
            job_id=job_id,
            artifacts=[
                {
                    "file_name": a.file_name,
                    **({"html": a.html} if a.html is not None else {}),
                    # GAP-145: バイナリ成果物 (画像 / PPTX / PDF 等)
                    **({"content_b64": a.content_b64} if a.content_b64 is not None else {}),
                }
                for a in body.artifacts
            ],
            requester_user_id=_token.user_id,
        )
    except ChatRelayError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": [ChatRelayArtifactResult(**r) for r in results]}  # type: ignore[arg-type]


@router.post(
    "/chat-relay/{job_id}/complete",
    summary="chat relay job 確定 (GAP-114 / BridgeAuth)",
)
async def chat_relay_complete(
    job_id: str, body: ChatRelayCompleteRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, dict[str, str]]:
    """running ジョブを done / error で確定する。

    GAP-119: Bridge が実行中に観測した rate_limit_event (本人プラン枠) が
    付いていれば chat_plan_status へ upsert する (無ければ何も書かない)。
    """
    try:
        if body.rate_limits:
            await relay_svc.record_plan_status(
                session,
                job_id=job_id,
                observations=[o.model_dump() for o in body.rate_limits],
            )
        await relay_svc.complete_job(session, job_id=job_id, ok=body.ok, error=body.error)
    except ChatRelayError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": {"status": "ok"}}
