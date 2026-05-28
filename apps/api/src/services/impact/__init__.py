"""影響範囲解析 (impact) サービス層 (T-A-23 / F-IMP01)。

同一 project 内の tasks を NetworkX の DiGraph に展開:
  edge (dep → task) — dep が変わると task に影響。
起点 task の `descendants` = 影響を受ける下流 task 群。可視性は RLS (T-D-16
tasks_*_member) が信頼源で、project member でない task は session から見えない
ため自然に scope される (read-only / audit_logs 不要)。
"""

from __future__ import annotations

import networkx as nx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.schemas.impact import ImpactAnalysisResponse


async def _fetch_root_project_id(session: AsyncSession, task_id: str) -> str | None:
    """起点 task の project_id を返す (RLS で不可視なら None)。"""
    res = await session.execute(
        text(
            "select project_id from public.tasks "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": task_id},
    )
    row = res.first()
    return None if row is None else str(row.project_id)


async def _fetch_project_edges(
    session: AsyncSession, project_id: str
) -> tuple[list[str], list[tuple[str, str]]]:
    """project 内の (可視) task ノードと依存エッジを返す。

    edge は (dep_task_id → task_id) の有向辺。dep が同 project 外/不可視のものは
    自然に nodes 集合に含まれず、グラフ構築側で無視される。
    """
    res = await session.execute(
        text(
            "select id, dependencies from public.tasks "
            "where project_id = cast(:pid as uuid) and deleted_at is null"
        ),
        {"pid": project_id},
    )
    nodes: list[str] = []
    edges: list[tuple[str, str]] = []
    rows = res.all()
    for row in rows:
        tid = str(row.id)
        nodes.append(tid)
        deps = row.dependencies or []
        for dep in deps:
            edges.append((str(dep), tid))
    return nodes, edges


async def analyze_downstream(
    session: AsyncSession, *, task_id: str
) -> ImpactAnalysisResponse | None:
    """起点 task の変更で影響を受ける下流 task 群 (descendants) を返す。

    起点が RLS で不可視 (= 別 WS / 削除済 / 不在) なら None → ルータで 404。
    """
    project_id = await _fetch_root_project_id(session, task_id)
    if project_id is None:
        return None
    nodes, edges = await _fetch_project_edges(session, project_id)
    g: nx.DiGraph[str] = nx.DiGraph()
    g.add_nodes_from(nodes)
    # 同 project 内で両端が可視なエッジのみ採用 (外部参照は無視)
    node_set = set(nodes)
    g.add_edges_from((u, v) for (u, v) in edges if u in node_set and v in node_set)
    if task_id not in g:  # pragma: no cover - project_id 取得直後に保証される
        return None
    descendants = sorted(nx.descendants(g, task_id))
    return ImpactAnalysisResponse(
        root_task_id=task_id,
        affected_task_ids=descendants,
        affected_count=len(descendants),
    )
