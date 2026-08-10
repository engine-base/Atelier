"""Chat スレッド CRUD + メッセージ送信 + 分岐 / feedback ルータ (T-A-16 / T-A-17 / T-A-19)。

/chat/threads, /chat/threads/{id}, /chat/threads/{id}/messages,
/chat/messages/{id}/feedback。認証 (401) + RLS (T-D-17) + 404/403。
分岐は POST messages に parent_message_id を渡して実現、feedback は audit_logs 記録。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.chat import (
    ChatAttachmentUploadUrlRequest,
    ChatAttachmentUploadUrlResponse,
    ChatAttachmentUrlResponse,
    ChatCommandRequest,
    ChatCommandResponse,
    MessageCreate,
    MessageFeedbackCreate,
    MessageFeedbackResponse,
    MessageResponse,
    ThreadCreate,
    ThreadResponse,
    ThreadUpdate,
    ToolApprovalExecuteResponse,
    ToolApprovalResponse,
)
from src.services import chat as svc
from src.services.chat_sse import tools as tools_svc
from src.storage_signing import StorageSigningError

router = APIRouter(tags=["chat"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/chat/threads", summary="チャットスレッド一覧")
async def list_threads(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    include_archived: Annotated[bool, Query()] = False,
) -> dict[str, list[ThreadResponse]]:
    return {
        "data": await svc.list_threads(
            session, project_id=project_id, include_archived=include_archived
        )
    }


@router.post("/chat/threads", status_code=status.HTTP_201_CREATED, summary="チャットスレッド作成")
async def create_thread(
    body: ThreadCreate, session: SessionDep, user: UserDep
) -> dict[str, ThreadResponse]:
    return {"data": await svc.create_thread(session, actor_id=user.id, data=body)}


@router.get("/chat/threads/{thread_id}", summary="チャットスレッド詳細")
async def get_thread(
    thread_id: str, session: SessionDep, _user: UserDep
) -> dict[str, ThreadResponse]:
    th = await svc.get_thread(session, thread_id)
    if th is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "thread not found")
    return {"data": th}


@router.patch("/chat/threads/{thread_id}", summary="チャットスレッド更新")
async def update_thread(
    thread_id: str, body: ThreadUpdate, session: SessionDep, user: UserDep
) -> dict[str, ThreadResponse]:
    if await svc.get_thread(session, thread_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "thread not found")
    updated = await svc.update_thread(session, actor_id=user.id, thread_id=thread_id, data=body)
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update thread")
    return {"data": updated}


@router.delete(
    "/chat/threads/{thread_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="チャットスレッド削除",
)
async def delete_thread(thread_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_thread(session, thread_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "thread not found")
    if not await svc.delete_thread(session, actor_id=user.id, thread_id=thread_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to delete thread")


@router.get("/chat/threads/{thread_id}/messages", summary="チャットメッセージ一覧")
async def list_messages(
    thread_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[MessageResponse]]:
    if await svc.get_thread(session, thread_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "thread not found")
    return {"data": await svc.list_messages(session, thread_id=thread_id)}


@router.post(
    "/chat/threads/{thread_id}/messages",
    status_code=status.HTTP_201_CREATED,
    summary="チャットメッセージ送信（即時 / ユーザー発話）",
)
async def create_message(
    thread_id: str, body: MessageCreate, session: SessionDep, user: UserDep
) -> dict[str, MessageResponse]:
    if await svc.get_thread(session, thread_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "thread not found")
    if not await svc.can_post_to_thread(session, thread_id=thread_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to post to thread")
    created = await svc.create_message(session, actor_id=user.id, thread_id=thread_id, data=body)
    return {"data": created}


@router.post(
    "/chat/threads/{thread_id}/commands",
    status_code=status.HTTP_201_CREATED,
    summary="チャット /コマンド の構造化実行 (GAP-002 / S-E01)",
)
async def execute_chat_command(
    thread_id: str, body: ChatCommandRequest, session: SessionDep, user: UserDep
) -> dict[str, ChatCommandResponse]:
    """/決定 (decisions 記録) / /タスク化 (tasks 起票) をサーバーで実行し、
    コマンド原文 (user) + 実行結果 (system) をスレッドへ永続する。
    """
    if await svc.get_thread(session, thread_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "thread not found")
    if not await svc.can_post_to_thread(session, thread_id=thread_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to post to thread")
    args = body.args.strip()
    if not args:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "command args must not be blank")
    result = await svc.execute_command(
        session,
        actor_id=user.id,
        thread_id=thread_id,
        command=body.command,
        args=args,
    )
    if result is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to execute command")
    return {"data": result}


@router.post(
    "/chat/attachments/upload-url",
    summary="チャット添付アップロード用 署名付き URL 発行 (GAP-001 / S-E01)",
    responses={503: {"description": "storage backend が未設定"}},
)
async def create_chat_attachment_upload_url(
    body: ChatAttachmentUploadUrlRequest, session: SessionDep, _user: UserDep
) -> dict[str, ChatAttachmentUploadUrlResponse]:
    """実ファイル PUT 用の署名付き URL を発行する (2 段階アップロードの 1 段目)。

    スレッド不可視は 404、viewer (投稿不可) は 403。確定は送信時の
    attachments (SSE stream body) で行う。
    """
    if await svc.get_thread(session, body.thread_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "thread not found")
    if not await svc.can_post_to_thread(session, thread_id=body.thread_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to post to thread")
    try:
        result = await svc.create_attachment_upload(
            thread_id=body.thread_id,
            file_name=body.file_name,
            mime_type=body.mime_type,
            file_size_bytes=body.file_size_bytes,
        )
    except svc.ChatAttachmentError as exc:
        if exc.code == "unsupported_media_type":
            raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, exc.message) from exc
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, exc.message) from exc
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    return {"data": result}


@router.get(
    "/chat/messages/{message_id}/attachments/{attachment_index}/url",
    summary="チャット添付の署名付きダウンロード URL (GAP-001)",
    responses={503: {"description": "storage backend が未設定"}},
)
async def get_chat_attachment_url(
    message_id: str,
    attachment_index: int,
    session: SessionDep,
    _user: UserDep,
) -> dict[str, ChatAttachmentUrlResponse]:
    """RLS で可視なメッセージの添付に対する署名付き閲覧 URL を返す。"""
    try:
        result = await svc.get_attachment_url(
            session, message_id=message_id, index=attachment_index
        )
    except svc.ChatAttachmentError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, exc.message) from exc
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "message not found")
    return {"data": result}


@router.post(
    "/chat/messages/{message_id}/branch",
    status_code=status.HTTP_201_CREATED,
    summary="メッセージ時点で新スレッドへ分岐 (GAP-031① — 履歴コピー + parent 連鎖)",
)
async def branch_thread(
    message_id: str, session: SessionDep, user: UserDep
) -> dict[str, ThreadResponse]:
    created = await svc.branch_thread_at_message(session, actor_id=user.id, message_id=message_id)
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "message not found")
    return {"data": created}


@router.post(
    "/chat/messages/{message_id}/feedback",
    status_code=status.HTTP_201_CREATED,
    summary="チャットメッセージへのフィードバック（T-A-19 / audit_logs 記録）",
)
async def create_message_feedback(
    message_id: str,
    body: MessageFeedbackCreate,
    session: SessionDep,
    user: UserDep,
) -> dict[str, MessageFeedbackResponse]:
    # 可視性: chat_messages_select_member RLS → 不可視なら 404
    if await svc.get_message_thread_id(session, message_id=message_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "message not found")
    created = await svc.create_message_feedback(
        session, actor_id=user.id, message_id=message_id, data=body
    )
    return {"data": created}


# --------------------------------------------------------------------------- #
# GAP-031①: ツール実行の人間承認 (S-E01 「承認して実行」/「差戻」)
# --------------------------------------------------------------------------- #
@router.get(
    "/chat/tool-approvals",
    summary="スレッドのツール実行承認一覧 (GAP-031① — 本人の inbox のみ)",
)
async def list_tool_approvals(
    session: SessionDep,
    _user: UserDep,
    thread_id: Annotated[str, Query()],
    status_filter: Annotated[str | None, Query(alias="status")] = "pending",
) -> dict[str, list[ToolApprovalResponse]]:
    rows = await tools_svc.list_tool_approvals(session, thread_id=thread_id, status=status_filter)
    return {"data": [ToolApprovalResponse(**r) for r in rows]}


@router.post(
    "/chat/tool-approvals/{approval_id}/execute",
    summary="承認して実行 (GAP-031① — pending の tool_execution を実行)",
)
async def execute_tool_approval(
    approval_id: str, session: SessionDep, user: UserDep
) -> dict[str, ToolApprovalExecuteResponse]:
    code, result = await tools_svc.execute_approved_tool(
        session, actor_id=user.id, approval_id=approval_id
    )
    if code == "not_found":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "approval not found")
    if code == "already_resolved":
        raise HTTPException(status.HTTP_409_CONFLICT, "approval already resolved")
    return {"data": ToolApprovalExecuteResponse(result=result)}


@router.post(
    "/chat/tool-approvals/{approval_id}/reject",
    summary="差戻 (GAP-031① — pending の tool_execution を却下)",
)
async def reject_tool_approval(
    approval_id: str, session: SessionDep, user: UserDep
) -> dict[str, bool]:
    code = await tools_svc.reject_tool_approval(session, actor_id=user.id, approval_id=approval_id)
    if code == "not_found":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "approval not found")
    if code == "already_resolved":
        raise HTTPException(status.HTTP_409_CONFLICT, "approval already resolved")
    return {"data": True}
