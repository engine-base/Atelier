"""横断検索（/search）サービス層 — T-UC-40。

project / task / knowledge / employee を ILIKE 前方一致で横断検索する。
可視性は RLS（get_rls_session）が担保するため、越境（R-T08）は自動的に除外される。
各 kind の SQL は id / title / snippet に正規化して SELECT するため、行→Hit 変換は
kind 非依存で統一できる。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.schemas.search import SearchHit, SearchKind

# kind ごとの検索 SQL。id / title / snippet に正規化して返す（:pat=ILIKE, :lim=件数上限）。
_SQL: dict[SearchKind, str] = {
    "project": (
        "select id, name as title, '' as snippet from public.projects "
        "where name ilike :pat and deleted_at is null "
        "order by updated_at desc limit :lim"
    ),
    "task": (
        "select id, title, coalesce(left(description, 120), '') as snippet "
        "from public.tasks "
        "where (title ilike :pat or description ilike :pat) and deleted_at is null "
        "order by updated_at desc limit :lim"
    ),
    "knowledge": (
        "select id, title, coalesce(left(content_md, 120), '') as snippet "
        "from public.knowledge_nodes "
        "where (title ilike :pat or content_md ilike :pat) and deleted_at is null "
        "order by updated_at desc limit :lim"
    ),
    "employee": (
        "select id, display_name as title, coalesce(role, '') as snippet "
        "from public.ai_employees "
        "where display_name ilike :pat "
        "order by display_name limit :lim"
    ),
}

# 1 kind あたりの最大ヒット数。
PER_KIND_LIMIT = 10


def kinds_for(kind: str) -> list[SearchKind]:
    """'all' なら全 kind、個別指定ならその 1 kind を返す。"""
    if kind == "all":
        return list(_SQL.keys())
    return [kind] if kind in _SQL else []


def row_to_hit(kind: SearchKind, row: Any) -> SearchHit:
    """正規化済み行（id/title/snippet）を SearchHit に変換する。"""
    return SearchHit(
        id=str(row.id),
        kind=kind,
        title=str(row.title),
        snippet=("" if row.snippet is None else str(row.snippet)),
    )


async def search(session: AsyncSession, *, q: str, kind: str) -> list[SearchHit]:
    pat = f"%{q}%"
    hits: list[SearchHit] = []
    for k in kinds_for(kind):
        res = await session.execute(text(_SQL[k]), {"pat": pat, "lim": PER_KIND_LIMIT})
        hits.extend(row_to_hit(k, r) for r in res.all())
    return hits
