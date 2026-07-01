"""横断検索（/search）ルータ — T-UC-40。

project / task / knowledge / employee を横断検索する。401（未認証）。
可視性は RLS が担保。
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.search import SearchHit
from src.services import search as svc

router = APIRouter(tags=["search"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]

SearchScope = Literal["all", "project", "task", "knowledge", "employee"]


@router.get("/search", summary="横断検索（project/task/knowledge/employee）")
async def search(
    session: SessionDep,
    _user: UserDep,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    kind: Annotated[SearchScope, Query()] = "all",
) -> dict[str, list[SearchHit]]:
    return {"data": await svc.search(session, q=q, kind=kind)}
