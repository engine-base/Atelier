"""成果物 (workflow_outputs) ルータ (T-A-21 / GAP-023)。

/outputs[/{id}]。認証 (401) + RLS (T-D-21) + 404。read が中心。
書込は「編集 = ドキュメント AI (スティーブ) への修正依頼」(revise) と
コメント起点の AI 修正提案 (fix-proposal) の承認/却下のみ。
"""

from __future__ import annotations

import asyncio
import urllib.parse
import uuid as uuid_mod
from functools import lru_cache
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.db.session import create_engine, create_session_factory
from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.diffs import VersionDiffResponse
from src.schemas.outputs import (
    DesignTemplateCreateRequest,
    FixProposalApproveResponse,
    FixProposalResponse,
    OutputAnchorResponse,
    OutputDesignTemplateResponse,
    OutputResponse,
    OutputReviseRequest,
    SheetResponse,
    SheetSaveRequest,
)
from src.schemas.shares import ShareLinkCreateRequest, ShareLinkResponse
from src.schemas.storage import ContentUrlResponse
from src.services import outputs as svc
from src.services.mocks.artifacts import (
    FILEDB_PREFIX,
    MOCKDB_PREFIX,
    build_content_url,
    fetch_file_content,
    fetch_mock_content,
    verify_content_token,
)
from src.services.outputs import fix_proposals as fix_svc
from src.services.outputs import revise as revise_svc
from src.storage_signing import StorageSigningError, create_signed_download_url

router = APIRouter(tags=["outputs"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@lru_cache(maxsize=8)
def _session_factory_for_loop(loop_key: int) -> async_sessionmaker[AsyncSession]:
    """GAP-139: mockdb 成果物配信用の service session (routes/mocks と同じ方式)。

    GAP-159: asyncpg の接続は event loop を跨いで再利用できないため、実行中 loop
    毎に engine を分離する (本番 uvicorn は単一 loop で挙動不変。テストは
    TestClient ブロック毎に新 loop を作るため、単一キャッシュだと 2 つ目以降の
    ブロックで死んだ loop の engine を掴んでしまう)。
    """
    del loop_key  # cache key 専用
    return create_session_factory(create_engine())


def _content_session_factory() -> async_sessionmaker[AsyncSession]:
    return _session_factory_for_loop(id(asyncio.get_running_loop()))


@router.get("/outputs", summary="成果物一覧")
async def list_outputs(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    phase_id: Annotated[str | None, Query()] = None,
    stage: Annotated[str | None, Query()] = None,
    delivery_phase_id: Annotated[str | None, Query()] = None,
) -> dict[str, list[OutputResponse]]:
    return {
        "data": await svc.list_outputs(
            session,
            project_id=project_id,
            phase_id=phase_id,
            stage=stage,
            delivery_phase_id=delivery_phase_id,
        )
    }


@router.get("/outputs/{output_id}", summary="成果物取得")
async def get_output(
    output_id: str, session: SessionDep, _user: UserDep
) -> dict[str, OutputResponse]:
    out = await svc.get_output(session, output_id)
    if out is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    return {"data": out}


@router.get(
    "/outputs/{output_id}/content-url",
    summary="成果物の署名付き閲覧 URL (format=html/json/md)",
    responses={503: {"description": "storage backend が未設定"}},
)
async def get_output_content_url(
    output_id: str,
    session: SessionDep,
    _user: UserDep,
    request: Request,
    format: Annotated[Literal["html", "json", "md"], Query()] = "html",
) -> dict[str, ContentUrlResponse]:
    """RLS で可視な output の format 別パスに対する署名付き閲覧 URL を返す。

    GAP-023: S-G01 の HTML/JSON/MD タブ + DL の実体。該当 format が未生成なら
    409 (存在しない版を偽装しない)。
    GAP-139: mockdb:// (チャット成果物の取り込み等) は自己署名 URL を返す。
    """
    out = await svc.get_output(session, output_id)
    if out is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    path = {"html": out.html_path, "json": out.json_path, "md": out.md_path}[format]
    if path is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"output has no rendered {format.upper()} yet"
        )
    if path.startswith(MOCKDB_PREFIX) or path.startswith(FILEDB_PREFIX):
        # GAP-139/145: DB 内蔵ストア (HTML / バイナリ) は自己署名 URL で配信
        return {
            "data": ContentUrlResponse(
                url=build_content_url(str(request.base_url), output_id, resource="outputs")
            )
        }
    try:
        url = await create_signed_download_url(path)
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    return {"data": ContentUrlResponse(url=url)}


@router.get(
    "/outputs/{output_id}/content",
    summary="DB 内蔵成果物の配信 — mockdb=HTML / filedb=バイナリ (自己署名トークン / GAP-139/145)",
)
async def get_output_content(
    output_id: str,
    exp: Annotated[int, Query(ge=0)],
    sig: Annotated[str, Query(min_length=32, max_length=128)],
    dl: Annotated[bool, Query()] = False,
) -> Response:
    """content-url が発行した期限付きトークンで DB 内蔵成果物を返す。

    routes/mocks の /mocks/{id}/content と同じ契約 — 可視性は content-url
    発行時に RLS で確認済みで、その証明が sig (HMAC)。
    GAP-145: filedb (画像/PPTX/PDF/Excel/動画 等) は実 MIME で配信し、
    dl=1 なら attachment (ダウンロード)、無指定なら inline (ブラウザ表示)。
    """
    if not verify_content_token(output_id, exp, sig):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "invalid or expired token")
    try:
        uuid_mod.UUID(output_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output content not found") from None
    factory = _content_session_factory()
    async with factory() as session:
        row = (
            await session.execute(
                text(
                    "select html_path from public.workflow_outputs "
                    "where id = cast(:i as uuid) and deleted_at is null"
                ),
                {"i": output_id},
            )
        ).first()
        path = None if row is None or row.html_path is None else str(row.html_path)
        if path is not None and path.startswith(FILEDB_PREFIX):
            found = await fetch_file_content(session, file_id=path[len(FILEDB_PREFIX) :])
            if found is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "output content not found")
            data, mime, file_name = found
            quoted = urllib.parse.quote(file_name)
            disposition = "attachment" if dl else "inline"
            return Response(
                content=data,
                media_type=mime,
                headers={
                    "Cache-Control": "private, max-age=60",
                    "X-Robots-Tag": "noindex",
                    "Content-Disposition": f"{disposition}; filename*=UTF-8''{quoted}",
                },
            )
        if path is None or not path.startswith(MOCKDB_PREFIX):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "output content not found")
        html = await fetch_mock_content(session, content_id=path[len(MOCKDB_PREFIX) :])
    if html is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output content not found")
    return HTMLResponse(
        content=html,
        headers={"Cache-Control": "private, max-age=60", "X-Robots-Tag": "noindex"},
    )


@router.get(
    "/workspaces/{workspace_id}/design-templates",
    summary="出力デザインテンプレ一覧 (GAP-158 — 種類ごとの最新版)",
)
async def list_design_templates(
    workspace_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[OutputDesignTemplateResponse]]:
    from src.services.outputs import templates as tmpl_svc

    items = await tmpl_svc.list_templates(session, workspace_id=workspace_id)
    if items is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "workspace not found")
    return {"data": items}


@router.get(
    "/workspaces/{workspace_id}/design-templates/{stage}/versions",
    summary="出力デザインテンプレの版履歴 (GAP-158)",
)
async def list_design_template_versions(
    workspace_id: str, stage: str, session: SessionDep, _user: UserDep
) -> dict[str, list[OutputDesignTemplateResponse]]:
    from src.services.outputs import templates as tmpl_svc

    items = await tmpl_svc.list_versions(session, workspace_id=workspace_id, stage=stage)
    if items is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "workspace not found")
    return {"data": items}


@router.post(
    "/workspaces/{workspace_id}/design-templates/{stage}",
    status_code=status.HTTP_201_CREATED,
    summary="ワンダにデザインテンプレを作成/改訂させる (GAP-158 — Open Design 型・新版が積まれる)",
    responses={503: {"description": "LLM 実行経路が使えない (Bridge オフライン等)"}},
)
async def create_design_template_version(
    workspace_id: str,
    stage: str,
    body: DesignTemplateCreateRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, OutputDesignTemplateResponse]:
    from src.services.outputs import templates as tmpl_svc

    try:
        created = await tmpl_svc.create_version(
            session,
            actor_id=user.id,
            workspace_id=workspace_id,
            stage=stage,
            instruction=body.instruction,
            reference_files=[f.model_dump() for f in body.reference_files],
        )
    except tmpl_svc.DesignTemplateError as exc:
        if exc.code in ("llm_unconfigured", "bridge_offline"):
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        if exc.code == "not_found":
            raise HTTPException(status.HTTP_404_NOT_FOUND, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "workspace not found")
    return {"data": created}


@router.post(
    "/workspaces/{workspace_id}/design-templates/{stage}/reset-to-default",
    summary="このワークスペースのデザインを運営既定に戻す (GAP-159 — 新版として積む)",
)
async def reset_design_template(
    workspace_id: str, stage: str, session: SessionDep, user: UserDep
) -> dict[str, OutputDesignTemplateResponse]:
    from src.services.outputs import templates as tmpl_svc

    try:
        created = await tmpl_svc.reset_to_platform_default(
            session, actor_id=user.id, workspace_id=workspace_id, stage=stage
        )
    except tmpl_svc.DesignTemplateError as exc:
        if exc.code == "already_default":
            raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
        raise HTTPException(status.HTTP_404_NOT_FOUND, exc.message) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "workspace not found")
    return {"data": created}


@router.get(
    "/design-templates/{template_id}/content-url",
    summary="デザインテンプレ HTML の自己署名閲覧 URL (GAP-158 — プレビュー iframe 用)",
)
async def get_design_template_content_url(
    template_id: str, session: SessionDep, _user: UserDep, request: Request
) -> dict[str, ContentUrlResponse]:
    from src.services.outputs import templates as tmpl_svc

    tmpl = await tmpl_svc.get_template(session, template_id=template_id)
    if tmpl is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "design template not found")
    return {
        "data": ContentUrlResponse(
            url=build_content_url(str(request.base_url), template_id, resource="design-templates")
        )
    }


@router.get(
    "/design-templates/{template_id}/content",
    summary="デザインテンプレ HTML の配信 (自己署名トークン / GAP-158)",
)
async def get_design_template_content(
    template_id: str,
    exp: Annotated[int, Query(ge=0)],
    sig: Annotated[str, Query(min_length=32, max_length=128)],
) -> HTMLResponse:
    if not verify_content_token(template_id, exp, sig):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "invalid or expired token")
    try:
        uuid_mod.UUID(template_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template content not found") from None
    from src.services.outputs import templates as tmpl_svc

    factory = _content_session_factory()
    async with factory() as session:
        path = await tmpl_svc.template_html_path(session, template_id=template_id)
        if path is None or not path.startswith(MOCKDB_PREFIX):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "template content not found")
        html = await fetch_mock_content(session, content_id=path[len(MOCKDB_PREFIX) :])
    if html is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template content not found")
    return HTMLResponse(
        content=html,
        headers={"Cache-Control": "private, max-age=60", "X-Robots-Tag": "noindex"},
    )


@router.get("/outputs/{output_id}/versions", summary="成果物のバージョン履歴")
async def list_output_versions(
    output_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[OutputResponse]]:
    """同一チェーン (project + stage + phase) のバージョンを version 昇順で返す。"""
    versions = await svc.list_versions(session, output_id)
    if not versions:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    return {"data": versions}


@router.get(
    "/outputs/{output_id}/diff/{other_id}",
    summary="バージョン間差分 (GAP-155 — {other_id} → {output_id} の unified diff)",
    responses={409: {"description": "別チェーン / バイナリ / 差分が大きすぎる"}},
)
async def diff_output_versions(
    output_id: str, other_id: str, session: SessionDep, _user: UserDep
) -> dict[str, VersionDiffResponse]:
    """同一チェーン内の 2 版の差分をサーバ側で実 HTML から計算して返す。

    バイナリ (filedb — 画像/PPTX 等) はテキスト差分に意味が無いため 409 で
    誠実に断る (テキスト化偽装をしない)。
    """
    from src.services import version_diff as diff_svc

    to_out = await svc.get_output(session, output_id)
    from_out = await svc.get_output(session, other_id)
    if to_out is None or from_out is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    same_chain = (
        to_out.project_id == from_out.project_id
        and to_out.stage == from_out.stage
        and to_out.phase_id == from_out.phase_id
        and str(to_out.meta.get("file_name", "")) == str(from_out.meta.get("file_name", ""))
    )
    if not same_chain:
        raise HTTPException(status.HTTP_409_CONFLICT, "別の成果物同士は差分を比較できません")
    if to_out.html_path is None or from_out.html_path is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "本文の無い版は差分を比較できません")
    try:
        from_html = await diff_svc.load_text_content(from_out.html_path)
        to_html = await diff_svc.load_text_content(to_out.html_path)
        diff, added, removed = diff_svc.unified_diff(
            from_label=f"v{from_out.version}",
            from_text=from_html,
            to_label=f"v{to_out.version}",
            to_text=to_html,
        )
    except diff_svc.VersionDiffError as exc:
        if exc.code in ("binary", "too_large"):
            raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    return {
        "data": VersionDiffResponse(
            from_id=from_out.id,
            from_version=from_out.version,
            to_id=to_out.id,
            to_version=to_out.version,
            added=added,
            removed=removed,
            identical=diff == "",
            diff=diff,
        )
    }


@router.post(
    "/outputs/{output_id}/restore",
    status_code=status.HTTP_201_CREATED,
    summary="旧バージョンを新バージョンとして復元 (GAP-155 — 履歴は消さない)",
    responses={409: {"description": "最新版 / 本文なし / 同時改訂と衝突"}},
)
async def restore_output_version(
    output_id: str, session: SessionDep, user: UserDep
) -> dict[str, OutputResponse]:
    try:
        created = await svc.restore_version(session, actor_id=user.id, output_id=output_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except svc.OutputVersionConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    return {"data": created}


@router.get(
    "/outputs/{output_id}/anchors",
    summary="成果物 HTML 内の id 付き要素 (コメント対象位置の候補)",
    responses={503: {"description": "storage backend が未設定"}},
)
async def list_output_anchors(
    output_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[OutputAnchorResponse]]:
    """実 HTML を取得して id 属性を抽出する — 推測の位置候補は返さない。"""
    out = await svc.get_output(session, output_id)
    if out is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    if out.html_path is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "output has no rendered HTML yet")
    from src.services import version_diff as diff_svc

    try:
        # GAP-155: mockdb:// (チャット取り込み等の DB 内蔵 HTML) も読めるローダーに
        # 統一 — 従来は storage 署名直行で mockdb 成果物の anchors が 503 になっていた
        html = await diff_svc.load_text_content(out.html_path)
    except diff_svc.VersionDiffError as exc:
        if exc.code == "binary":
            raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    return {"data": revise_svc.extract_anchors(html)}


def _raise_revise_error(exc: revise_svc.OutputReviseError) -> None:
    if exc.code == "llm_unconfigured":
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
    if exc.code == "too_large":
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, exc.message) from exc
    if exc.code == "no_html":
        raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
    raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc


@router.post(
    "/outputs/{output_id}/revise",
    status_code=status.HTTP_201_CREATED,
    summary="編集 = ドキュメント AI (スティーブ) への修正依頼 → 新バージョン生成 (GAP-023)",
    responses={503: {"description": "LLM または storage が未設定"}},
)
async def revise_output(
    output_id: str, body: OutputReviseRequest, session: SessionDep, user: UserDep
) -> dict[str, OutputResponse]:
    try:
        created = await revise_svc.revise_output(
            session, actor_id=user.id, output_id=output_id, instruction=body.instruction
        )
    except svc.OutputVersionConflict as exc:
        # GAP-155: 同時改訂の衝突は 409 で誠実に (lost update を隠さない)
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except revise_svc.OutputReviseError as exc:
        _raise_revise_error(exc)
        raise  # unreachable — 型のため
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    return {"data": created}


@router.get("/outputs/{output_id}/fix-proposals", summary="AI 修正提案一覧 (GAP-023)")
async def list_output_fix_proposals(
    output_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[FixProposalResponse]]:
    if await svc.get_output(session, output_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    return {"data": await fix_svc.list_for_output(session, output_id)}


@router.post(
    "/comments/{comment_id}/fix-proposal",
    status_code=status.HTTP_201_CREATED,
    summary="コメントへの AI (スティーブ) 修正提案を生成 (GAP-023)",
    responses={503: {"description": "LLM または storage が未設定"}},
)
async def create_fix_proposal(
    comment_id: str, session: SessionDep, user: UserDep
) -> dict[str, FixProposalResponse]:
    try:
        created = await fix_svc.propose(session, actor_id=user.id, comment_id=comment_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except revise_svc.OutputReviseError as exc:
        _raise_revise_error(exc)
        raise
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    if created is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "comment not found or not a workflow_output comment"
        )
    return {"data": created}


@router.post(
    "/output-fix-proposals/{proposal_id}/approve",
    summary="AI 修正提案を承認 → 提案を適用した新バージョンを生成 (GAP-023)",
    responses={503: {"description": "LLM または storage が未設定"}},
)
async def approve_fix_proposal(
    proposal_id: str, session: SessionDep, user: UserDep
) -> dict[str, FixProposalApproveResponse]:
    try:
        result = await fix_svc.approve(session, actor_id=user.id, proposal_id=proposal_id)
    except (ValueError, svc.OutputVersionConflict) as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except revise_svc.OutputReviseError as exc:
        _raise_revise_error(exc)
        raise
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "fix proposal not found")
    proposal, new_output = result
    return {"data": FixProposalApproveResponse(proposal=proposal, new_output=new_output)}


@router.post(
    "/output-fix-proposals/{proposal_id}/reject",
    summary="AI 修正提案を却下 (文書は不変) (GAP-023)",
)
async def reject_fix_proposal(
    proposal_id: str, session: SessionDep, user: UserDep
) -> dict[str, FixProposalResponse]:
    try:
        rejected = await fix_svc.reject(session, actor_id=user.id, proposal_id=proposal_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    if rejected is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "fix proposal not found")
    return {"data": rejected}


# ── GAP-162: 共有リンク + 出力形式 (HTML / PDF / Excel) ────────────────


def _share_url(base_url: str, token: str) -> str:
    return f"{base_url.rstrip('/')}/share/{token}"


def _to_share_response(link: Any, *, share_url: str | None = None) -> ShareLinkResponse:
    return ShareLinkResponse(
        id=link.id,
        output_id=link.output_id,
        label=link.label,
        expires_at=link.expires_at,
        revoked_at=link.revoked_at,
        view_count=link.view_count,
        last_viewed_at=link.last_viewed_at,
        created_at=link.created_at,
        share_url=share_url,
    )


@router.post(
    "/outputs/{output_id}/share-links",
    status_code=status.HTTP_201_CREATED,
    summary="成果物のクライアント共有リンクを発行 (GAP-162 — 期限つき・失効可)",
)
async def create_output_share_link(
    output_id: str,
    body: ShareLinkCreateRequest,
    session: SessionDep,
    user: UserDep,
    request: Request,
) -> dict[str, ShareLinkResponse]:
    from src.services.outputs import sharing

    link = await sharing.create_share_link(
        session,
        actor_id=user.id,
        output_id=output_id,
        label=body.label,
        expires_days=body.expires_days,
    )
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    return {
        "data": _to_share_response(
            link, share_url=_share_url(str(request.base_url), link.token or "")
        )
    }


@router.get(
    "/outputs/{output_id}/share-links",
    summary="成果物の共有リンク一覧 (GAP-162 — URL 自体は再取得不可)",
)
async def list_output_share_links(
    output_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[ShareLinkResponse]]:
    from src.services.outputs import sharing

    links = await sharing.list_share_links(session, output_id=output_id)
    return {"data": [_to_share_response(x) for x in links]}


@router.post(
    "/share-links/{link_id}/revoke",
    summary="共有リンクを無効化 (GAP-162 — 以後の閲覧は 410)",
)
async def revoke_output_share_link(
    link_id: str, session: SessionDep, user: UserDep
) -> dict[str, ShareLinkResponse]:
    from src.services.outputs import sharing

    link = await sharing.revoke_share_link(session, actor_id=user.id, link_id=link_id)
    if link is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "share link not found or already revoked")
    return {"data": _to_share_response(link)}


@router.get(
    "/share/{token}",
    summary="共有リンクの閲覧 (GAP-162 — 認証不要・クライアントに渡す用)",
    responses={410: {"description": "失効済み / 期限切れ"}},
)
async def view_shared_output(token: str) -> HTMLResponse:
    from src.services.outputs import sharing

    factory = _content_session_factory()
    async with factory() as session:
        try:
            output_id, html = await sharing.resolve_share_token(session, token=token)
        except sharing.ShareError as exc:
            code = {
                "not_found": status.HTTP_404_NOT_FOUND,
                "gone": status.HTTP_410_GONE,
                "no_html": status.HTTP_404_NOT_FOUND,
            }.get(exc.code, status.HTTP_404_NOT_FOUND)
            raise HTTPException(code, exc.message) from exc
        row = (
            await session.execute(
                text(
                    "select summary, stage::text as stage from public.workflow_outputs where id = :i"
                ),
                {"i": output_id},
            )
        ).first()
        await session.commit()
    title = str(row.summary or row.stage) if row is not None else "成果物"
    return HTMLResponse(
        content=sharing.share_page_html(html, title=title),
        headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex"},
    )


@router.get(
    "/outputs/{output_id}/export",
    summary="成果物の書き出し (GAP-162 — html / xlsx。PDF は共有ページの印刷から)",
    responses={409: {"description": "この形式では出力できない (表が無い等)"}},
)
async def export_output(
    output_id: str,
    fmt: Annotated[Literal["html", "xlsx"], Query(alias="format")],
    session: SessionDep,
    _user: UserDep,
) -> Response:
    from src.services.outputs import sharing

    current = await svc.get_output(session, output_id)
    if current is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    if current.html_path is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "この成果物には書き出せる内容がありません")
    try:
        html = await sharing.load_output_html(current.html_path)
    except sharing.ShareError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
    name = (current.summary or current.stage or "output").replace("/", "_")[:60]
    if fmt == "html":
        return Response(
            content=html.encode("utf-8"),
            media_type="text/html; charset=utf-8",
            headers={
                "Content-Disposition": (
                    f"attachment; filename*=UTF-8''{urllib.parse.quote(name)}.html"
                )
            },
        )
    try:
        data = sharing.html_tables_to_xlsx(html, title=name)
    except sharing.ShareError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": (f"attachment; filename*=UTF-8''{urllib.parse.quote(name)}.xlsx")
        },
    )


# ── GAP-163: Excel / CSV 成果物の表表示と編集 ────────────────────────


@router.get(
    "/outputs/{output_id}/sheet",
    summary="Excel / CSV 成果物を表として取得 (GAP-163 — ツール内表示)",
    responses={409: {"description": "表として扱えない形式 (PDF 等)"}},
)
async def get_output_sheet(
    output_id: str, session: SessionDep, _user: UserDep
) -> dict[str, SheetResponse]:
    from src.services.outputs import sheets as sheets_svc

    try:
        data = await sheets_svc.load_sheet(session, output_id=output_id)
    except sheets_svc.SheetError as exc:
        code = status.HTTP_404_NOT_FOUND if exc.code == "not_found" else status.HTTP_409_CONFLICT
        raise HTTPException(code, exc.message) from exc
    return {
        "data": SheetResponse(
            file_name=data.file_name,
            mime=data.mime,
            editable=data.editable,
            sheets=data.sheets,
            note=data.note,
        )
    }


@router.post(
    "/outputs/{output_id}/sheet",
    status_code=status.HTTP_201_CREATED,
    summary="表の編集を新バージョンとして保存 (GAP-163 — 元の版は残る)",
    responses={409: {"description": "編集できない形式"}},
)
async def save_output_sheet(
    output_id: str, body: SheetSaveRequest, session: SessionDep, user: UserDep
) -> dict[str, OutputResponse]:
    from src.services.outputs import sheets as sheets_svc

    try:
        new_id = await sheets_svc.save_sheet(
            session, actor_id=user.id, output_id=output_id, sheets=body.sheets
        )
    except sheets_svc.SheetError as exc:
        code = status.HTTP_404_NOT_FOUND if exc.code == "not_found" else status.HTTP_409_CONFLICT
        raise HTTPException(code, exc.message) from exc
    if new_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    created = await svc.get_output(session, new_id)
    if created is None:  # pragma: no cover - 直前に作成済
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    return {"data": created}


# ── GAP-166: ファイル成果物を本人の Claude Code に直してもらう ────────


class FileEditRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=4000)


@router.post(
    "/outputs/{output_id}/ai-file-edit",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Excel/PDF 等を本人の PC の Claude Code に直してもらう (GAP-166)",
    responses={
        409: {"description": "この形式はファイル編集に対応していない"},
        503: {"description": "Bridge がオフライン"},
    },
)
async def request_output_file_edit(
    output_id: str, body: FileEditRequest, session: SessionDep, user: UserDep
) -> dict[str, dict[str, str]]:
    from src.services.outputs import file_edit

    try:
        job_id = await file_edit.request_file_edit(
            session, actor_id=user.id, output_id=output_id, instruction=body.instruction
        )
    except file_edit.FileEditError as exc:
        code = {
            "not_found": status.HTTP_404_NOT_FOUND,
            "unsupported": status.HTTP_409_CONFLICT,
            "bridge_offline": status.HTTP_503_SERVICE_UNAVAILABLE,
        }.get(exc.code, status.HTTP_409_CONFLICT)
        raise HTTPException(code, exc.message) from exc
    return {"data": {"job_id": job_id}}
