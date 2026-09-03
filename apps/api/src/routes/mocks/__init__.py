"""Mock CRUD + バージョン管理 ルータ (T-A-33)。

/mocks, /mocks/{id}, /mocks/{id}/versions。認証は get_current_user (401)、
可視性/権限は RLS (T-D-17) + 404/403。
"""

from __future__ import annotations

import uuid
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import HTMLResponse, StreamingResponse
from sqlalchemy import text
from sqlalchemy import text as sql_text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.db.session import shared_session_factory
from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.errors import service_unavailable
from src.schemas.diffs import VersionDiffResponse
from src.schemas.mocks import (
    DesignNoteUpdate,
    MockCreate,
    MockGenerateRequest,
    MockResponse,
    MockReviseRequest,
    MockUpdate,
    MockVersionCreate,
)
from src.schemas.storage import ContentUrlResponse
from src.services import mocks as svc
from src.services.mocks.artifacts import (
    MOCKDB_PREFIX,
    build_content_url,
    fetch_mock_content,
    inject_selection_script,
    verify_content_token,
)
from src.storage_signing import StorageSigningError, create_signed_download_url
from src.user_messages import user_detail

router = APIRouter(tags=["mocks"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@lru_cache(maxsize=1)
def _content_session_factory() -> async_sessionmaker[AsyncSession]:
    """GAP-137: mockdb コンテンツ配信用の service session。

    /mocks/{id}/content は iframe から Authorization ヘッダ無しで届くため
    JWT 依存の RLS session は使えない — 代わりに自己署名トークン
    (content-url 取得時に RLS で可視性を確認済み) を検証して配信する。
    """
    # GAP-197: engine はプロセスに 1 つ
    return shared_session_factory()


@router.get("/mocks", summary="モック一覧")
async def list_mocks(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    screen_name: Annotated[str | None, Query()] = None,
    delivery_phase_id: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, list[MockResponse]]:
    return {
        "data": await svc.list_mocks(
            session,
            project_id=project_id,
            screen_name=screen_name,
            delivery_phase_id=delivery_phase_id,
            limit=limit,
        )
    }


@router.post("/mocks", status_code=status.HTTP_201_CREATED, summary="モック作成")
async def create_mock(
    body: MockCreate, session: SessionDep, user: UserDep
) -> dict[str, MockResponse]:
    try:
        return {"data": await svc.create_mock(session, actor_id=user.id, data=body)}
    except svc.MockNameTaken as exc:
        # GAP-228: 名前の重複は利用者が直せる入力の問題 — 500 ではなく 409 で理由を言う
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"「{exc.screen_name}」という画面は既にあります。"
            "別の名前にするか、既存の画面へ新しい版として追加してください。",
        ) from exc


@router.get("/mocks/{mock_id}", summary="モック詳細")
async def get_mock(mock_id: str, session: SessionDep, _user: UserDep) -> dict[str, MockResponse]:
    mock = await svc.get_mock(session, mock_id)
    if mock is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のモックが見つかりません。")
    return {"data": mock}


@router.get(
    "/mocks/{mock_id}/content-url",
    summary="モック HTML の署名付き閲覧 URL",
    responses={503: {"description": "storage backend が未設定"}},
)
async def get_mock_content_url(
    mock_id: str, session: SessionDep, _user: UserDep, request: Request
) -> dict[str, ContentUrlResponse]:
    """RLS で可視な mock の html_storage_path に対する署名付き閲覧 URL を返す。

    GAP-137: mockdb:// (DB 内蔵 HTML — チャット成果物の取り込み等) は
    Supabase Storage を使わず、自己署名の期限付き URL (/mocks/{id}/content)
    を返す。従来の '{bucket}/{object}' は Supabase 署名 URL のまま。
    """
    mock = await svc.get_mock(session, mock_id)
    if mock is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のモックが見つかりません。")
    if mock.html_storage_path.startswith(MOCKDB_PREFIX):
        return {"data": ContentUrlResponse(url=build_content_url(str(request.base_url), mock_id))}
    try:
        url = await create_signed_download_url(mock.html_storage_path)
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise service_unavailable(exc.code, user_detail(exc)) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, user_detail(exc)) from exc
    return {"data": ContentUrlResponse(url=url)}


@router.get(
    "/mocks/{mock_id}/content",
    summary="mockdb モック HTML の配信 (自己署名トークン / GAP-137)",
    response_class=HTMLResponse,
)
async def get_mock_content(
    mock_id: str,
    exp: Annotated[int, Query(ge=0)],
    sig: Annotated[str, Query(min_length=32, max_length=128)],
    sel: Annotated[int, Query(ge=0, le=1)] = 0,
) -> HTMLResponse:
    """content-url が発行した期限付きトークンで mockdb HTML を返す。

    iframe から Authorization 無しで届くため JWT は使わない — 可視性は
    content-url 発行時に RLS で確認済みで、その証明が sig (HMAC)。
    GAP-142: sel=1 で要素選択スクリプト (Open Design 型のクリック選択) を注入。
    """
    if not verify_content_token(mock_id, exp, sig):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "リンクが正しくないか、有効期限が切れています。"
        )
    try:
        uuid.UUID(mock_id)
    except ValueError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "このモックの中身がまだありません。"
        ) from None
    factory = _content_session_factory()
    async with factory() as session:
        row = (
            await session.execute(
                text(
                    "select html_storage_path from public.mocks "
                    "where id = cast(:i as uuid) and deleted_at is null"
                ),
                {"i": mock_id},
            )
        ).first()
        if row is None or not str(row.html_storage_path).startswith(MOCKDB_PREFIX):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "このモックの中身がまだありません。")
        html = await fetch_mock_content(
            session, content_id=str(row.html_storage_path)[len(MOCKDB_PREFIX) :]
        )
    if html is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "このモックの中身がまだありません。")
    if sel == 1:
        html = inject_selection_script(html)
    return HTMLResponse(
        content=html,
        headers={"Cache-Control": "private, max-age=60", "X-Robots-Tag": "noindex"},
    )


@router.patch("/mocks/{mock_id}", summary="モック更新")
async def update_mock(
    mock_id: str, body: MockUpdate, session: SessionDep, user: UserDep
) -> dict[str, MockResponse]:
    if await svc.get_mock(session, mock_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のモックが見つかりません。")
    try:
        updated = await svc.update_mock(session, actor_id=user.id, mock_id=mock_id, data=body)
    except svc.MockPhaseFrozen as exc:
        # GAP-152: 確定フェーズの成果物は不変
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "確定済みのフェーズの成果物は変更できません。追加や修正は次のフェーズで行ってください。",
        ) from exc
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "このモックを変更する権限がありません。")
    return {"data": updated}


@router.delete(
    "/mocks/{mock_id}", status_code=status.HTTP_204_NO_CONTENT, summary="モック削除（論理）"
)
async def delete_mock(mock_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_mock(session, mock_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のモックが見つかりません。")
    try:
        ok = await svc.delete_mock(session, actor_id=user.id, mock_id=mock_id)
    except svc.MockPhaseFrozen as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "確定済みのフェーズの成果物は変更できません。追加や修正は次のフェーズで行ってください。",
        ) from exc
    if not ok:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "このモックを削除する権限がありません。")


@router.get("/mocks/{mock_id}/versions", summary="モックのバージョン履歴")
async def list_versions(
    mock_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[MockResponse]]:
    if await svc.get_mock(session, mock_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のモックが見つかりません。")
    return {"data": await svc.list_versions(session, mock_id)}


@router.post(
    "/mocks/{mock_id}/versions",
    status_code=status.HTTP_201_CREATED,
    summary="モックの新バージョン作成",
    responses={409: {"description": "他のメンバーの同時改訂と衝突 (GAP-155)"}},
)
async def create_version(
    mock_id: str, body: MockVersionCreate, session: SessionDep, user: UserDep
) -> dict[str, MockResponse]:
    try:
        created = await svc.create_version(session, actor_id=user.id, mock_id=mock_id, data=body)
    except svc.MockVersionConflict as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "ほかの編集と同時に保存されたため、反映できませんでした。"
            "最新の内容を読み直してから、もう一度お試しください。",
        ) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のモックが見つかりません。")
    return {"data": created}


@router.get(
    "/mocks/{mock_id}/diff/{other_id}",
    summary="バージョン間差分 (GAP-155 — {other_id} → {mock_id} の unified diff)",
    responses={409: {"description": "別チェーン同士 / 差分が大きすぎる"}},
)
async def diff_mock_versions(
    mock_id: str, other_id: str, session: SessionDep, _user: UserDep
) -> dict[str, VersionDiffResponse]:
    """同一画面チェーン内の 2 版の差分をサーバ側で実 HTML から計算して返す。"""
    from src.services import version_diff as diff_svc

    to_mock = await svc.get_mock(session, mock_id)
    from_mock = await svc.get_mock(session, other_id)
    if to_mock is None or from_mock is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のモックが見つかりません。")
    if (to_mock.project_id, to_mock.screen_name) != (
        from_mock.project_id,
        from_mock.screen_name,
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "別の画面同士は差分を比較できません")
    try:
        from_html = await diff_svc.load_text_content(from_mock.html_storage_path)
        to_html = await diff_svc.load_text_content(to_mock.html_storage_path)
        diff, added, removed = diff_svc.unified_diff(
            from_label=f"v{from_mock.version}",
            from_text=from_html,
            to_label=f"v{to_mock.version}",
            to_text=to_html,
        )
    except diff_svc.VersionDiffError as exc:
        if exc.code in ("binary", "too_large"):
            raise HTTPException(status.HTTP_409_CONFLICT, user_detail(exc)) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, user_detail(exc)) from exc
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise service_unavailable(exc.code, user_detail(exc)) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, user_detail(exc)) from exc
    return {
        "data": VersionDiffResponse(
            from_id=from_mock.id,
            from_version=from_mock.version,
            to_id=to_mock.id,
            to_version=to_mock.version,
            added=added,
            removed=removed,
            identical=diff == "",
            diff=diff,
        )
    }


@router.get(
    "/projects/{project_id}/design-note",
    summary="デザインノート取得 (GAP-143 — Open Design の DESIGN.md 相当)",
)
async def get_project_design_note(
    project_id: str, session: SessionDep, _user: UserDep
) -> dict[str, dict[str, str]]:
    """プロジェクトのデザインノート。ワンダの全生成・改訂に自動注入される。"""
    from src.services.mocks import design_note as note_svc

    visible = (
        await session.execute(
            sql_text("select 1 from public.projects where id = cast(:p as uuid)"),
            {"p": project_id},
        )
    ).first()
    if visible is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のプロジェクトが見つかりません。")
    note = await note_svc.get_design_note(session, project_id=project_id)
    return {"data": {"note": note}}


@router.put(
    "/projects/{project_id}/design-note",
    summary="デザインノート保存 (GAP-143)",
)
async def put_project_design_note(
    project_id: str, body: DesignNoteUpdate, session: SessionDep, user: UserDep
) -> dict[str, dict[str, str]]:
    from src.services.mocks import design_note as note_svc

    ok = await note_svc.set_design_note(
        session, actor_id=user.id, project_id=project_id, note=body.note
    )
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のプロジェクトが見つかりません。")
    return {"data": {"note": body.note[: note_svc.DESIGN_NOTE_MAX_CHARS]}}


@router.post(
    "/mocks/generate",
    status_code=status.HTTP_201_CREATED,
    summary="新規モック生成 = ワンダ (AI) による新規作成 (GAP-138)",
    responses={503: {"description": "LLM 実行経路が使えない (Bridge オフライン等)"}},
)
async def generate_mock(
    body: MockGenerateRequest, session: SessionDep, user: UserDep
) -> dict[str, MockResponse]:
    """指示文から 1 画面のモックを新規生成する (mockdb 保存・同名画面は版連鎖)。

    LLM は relay (本人の Claude サブスク) → agent_sdk → API → fake の
    費用順チェーン (GAP-138 — 確定アーキテクチャに整合)。
    """
    from src.services.mocks import generate as generate_svc
    from src.services.mocks import revise as revise_svc

    try:
        created = await generate_svc.generate_mock(
            session,
            actor_id=user.id,
            project_id=body.project_id,
            instruction=body.instruction,
            screen_name=body.screen_name,
        )
    except revise_svc.MockReviseError as exc:
        if exc.code in ("llm_unconfigured", "bridge_offline"):
            raise service_unavailable(exc.code, user_detail(exc)) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, user_detail(exc)) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のプロジェクトが見つかりません。")
    return {"data": created}


@router.post(
    "/mocks/{mock_id}/revise",
    status_code=status.HTTP_201_CREATED,
    summary="編集 = ワンダ (AI) への修正依頼 → 新バージョン生成 (GAP-024 / Open Design パターン)",
    responses={503: {"description": "LLM または storage が未設定"}},
)
async def revise_mock(
    mock_id: str, body: MockReviseRequest, session: SessionDep, user: UserDep
) -> dict[str, MockResponse]:
    from src.services.mocks import revise as revise_svc

    try:
        created = await revise_svc.revise_mock(
            session,
            actor_id=user.id,
            mock_id=mock_id,
            instruction=body.instruction,
            reference_files=[r.model_dump() for r in body.reference_files],
        )
    except svc.MockPhaseFrozen as exc:
        # GAP-255: 確定済みフェーズのモックは AI 改訂も不可 (破棄・削除と同じ 409)
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "確定済みのフェーズの成果物は変更できません。追加や修正は次のフェーズで行ってください。",
        ) from exc
    except revise_svc.MockReviseError as exc:
        if exc.code in ("llm_unconfigured", "bridge_offline"):
            # GAP-138: Bridge オフラインも「実行経路が無い」— 黙って API 課金に落とさない
            raise service_unavailable(exc.code, user_detail(exc)) from exc
        if exc.code == "too_large":
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, user_detail(exc)) from exc
        if exc.code == "conflict":
            # GAP-155: 同時改訂の衝突は 409 で誠実に (lost update を隠さない)
            raise HTTPException(status.HTTP_409_CONFLICT, user_detail(exc)) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, user_detail(exc)) from exc
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise service_unavailable(exc.code, user_detail(exc)) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, user_detail(exc)) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のモックが見つかりません。")
    return {"data": created}


@router.post(
    "/mocks/{mock_id}/revise/stream",
    summary="修正依頼の進行状況ストリーミング (GAP-147 — SSE: stage/progress/result)",
)
async def revise_mock_stream(
    mock_id: str, body: MockReviseRequest, session: SessionDep, user: UserDep
) -> StreamingResponse:
    """ワンダの改訂を SSE で逐次配信する。

    data: {"stage": "loading"|"generating"|"saving", ...}
    data: {"progress": {"chars": n}}       — 生成済み文字数 (実測)
    data: {"result": {...新バージョン, "summary"}} — 完了
    data: {"error": {"code", "message"}}   — 失敗 (誠実にそのまま)
    """
    import json as _json

    from src.services.mocks import revise as revise_svc

    async def _events():
        async for ev in revise_svc.revise_mock_stream(
            session,
            actor_id=user.id,
            mock_id=mock_id,
            instruction=body.instruction,
            reference_files=[r.model_dump() for r in body.reference_files],
        ):
            yield f"data: {_json.dumps(ev, ensure_ascii=False)}\n\n".encode()

    # GAP-198: SSE は張っている間ずっと DB セッションを掴むので、同じ上限に載せる
    from src.routes.chat_sse import guarded_stream

    return guarded_stream(_events())


@router.post(
    "/mocks/{mock_id}/duplicate",
    status_code=status.HTTP_201_CREATED,
    summary="バージョン複製 (GAP-024 — 「…」メニュー)",
)
async def duplicate_mock_version(
    mock_id: str, session: SessionDep, user: UserDep
) -> dict[str, MockResponse]:
    try:
        created = await svc.duplicate_version(session, actor_id=user.id, mock_id=mock_id)
    except svc.MockVersionConflict as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "ほかの編集と同時に保存されたため、反映できませんでした。"
            "最新の内容を読み直してから、もう一度お試しください。",
        ) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のモックが見つかりません。")
    return {"data": created}


@router.post(
    "/mocks/{mock_id}/discard",
    summary="バージョン破棄 (GAP-024 — 唯一の生存バージョンは 409)",
)
async def discard_mock_version(
    mock_id: str, session: SessionDep, user: UserDep
) -> dict[str, dict[str, str]]:
    try:
        ok = await svc.discard_version(session, actor_id=user.id, mock_id=mock_id)
    except (ValueError, svc.MockPhaseFrozen) as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "確定済みのフェーズの成果物は変更できません。追加や修正は次のフェーズで行ってください。",
        ) from exc
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のモックが見つかりません。")
    return {"data": {"mock_id": mock_id, "status": "discarded"}}
