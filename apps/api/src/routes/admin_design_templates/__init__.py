"""運営 (プラットフォーム) 既定デザインテンプレ ルータ — GAP-159。

経営者指示「初めのデフォルトはこちらの管理側で設定しているものでいい」
「管理側でデフォルトを決めるが、そこでも変更・更新・追加などできる状態に」。

運営既定 (output_design_templates.is_platform_default) は全テナントが継承する
初期デザイン。RLS 上テナントからは read-only のため、書込はここで
is_admin gate (403) + service セッション (RLS バイパス) で行う。
ユーザー側と同じ Open Design の作り (ワンダへの指示 → 版が積まれる)。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.db.session import shared_session_factory
from src.dependencies import CurrentUser, get_current_user
from src.errors import service_unavailable
from src.schemas.outputs import DesignTemplateCreateRequest, OutputDesignTemplateResponse
from src.services import admin as admin_svc
from src.services.outputs import templates as tmpl_svc

router = APIRouter(tags=["admin-design-templates"])

UserDep = Annotated[CurrentUser, Depends(get_current_user)]


def _service_session_factory() -> async_sessionmaker[AsyncSession]:
    """GAP-197: engine はプロセスに 1 つ。

    以前は event loop ごとに engine を作ってキャッシュしていたが、engine を
    共有にしたのでこの層は不要になった (loop id は再利用されうるので、
    残しておくと死んだ engine を掴み続ける危険がある)。
    """
    return shared_session_factory()


def _require_admin(user: CurrentUser) -> None:
    if not admin_svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")


@router.get(
    "/admin/design-templates",
    summary="運営 admin: 既定デザインテンプレ一覧 (種類ごとの最新版)",
)
async def list_platform_design_templates(
    user: UserDep,
) -> dict[str, list[OutputDesignTemplateResponse]]:
    _require_admin(user)
    async with _service_session_factory()() as session:
        items = await tmpl_svc.list_platform_templates(session)
    return {"data": items}


@router.get(
    "/admin/design-templates/{stage}/versions",
    summary="運営 admin: 既定デザインテンプレの版履歴",
)
async def list_platform_design_template_versions(
    stage: str, user: UserDep
) -> dict[str, list[OutputDesignTemplateResponse]]:
    _require_admin(user)
    async with _service_session_factory()() as session:
        items = await tmpl_svc.list_versions(session, workspace_id=None, stage=stage)
    return {"data": items or []}


@router.post(
    "/admin/design-templates/{stage}",
    status_code=status.HTTP_201_CREATED,
    summary="運営 admin: ワンダに既定デザインを作成/改訂させる (新版が積まれる)",
    responses={503: {"description": "LLM 実行経路が使えない (Bridge オフライン等)"}},
)
async def create_platform_design_template_version(
    stage: str, body: DesignTemplateCreateRequest, user: UserDep
) -> dict[str, OutputDesignTemplateResponse]:
    _require_admin(user)
    async with _service_session_factory()() as session:
        try:
            created = await tmpl_svc.create_version(
                session,
                actor_id=user.id,
                workspace_id=None,
                stage=stage,
                instruction=body.instruction,
                reference_files=[f.model_dump() for f in body.reference_files],
            )
        except tmpl_svc.DesignTemplateError as exc:
            if exc.code in ("llm_unconfigured", "bridge_offline"):
                raise service_unavailable(exc.code, exc.message) from exc
            if exc.code == "not_found":
                raise HTTPException(status.HTTP_404_NOT_FOUND, exc.message) from exc
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
        await session.commit()
    if created is None:  # pragma: no cover - platform 経路は workspace 可視性に依存しない
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象が見つかりません。")
    return {"data": created}
