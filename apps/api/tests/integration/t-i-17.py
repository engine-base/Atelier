"""T-I-17 F-IMP01 影響範囲解析 NetworkX 試験.

実 service `src.services.impact.analyze_downstream` を DB-free stub session で
exercise し、NetworkX DiGraph の descendants 計算が正しいこと、RLS 不可視時に
None を返すことを検証する。
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass

import networkx as nx

from src.services.impact import analyze_downstream

from ._stub import StubResult, StubSession


@dataclass
class _ProjRow:
    project_id: str


@dataclass
class _TaskRow:
    id: str
    dependencies: list[str]


def test_analyze_downstream_returns_descendants() -> None:
    """t1 → t2, t1 → t3, t3 → t4 で t1 の affected は {t2,t3,t4} (実 service)."""
    t1, t2, t3, t4 = (str(uuid.uuid4()) for _ in range(4))
    pid = str(uuid.uuid4())
    # 1) _fetch_root_project_id, 2) _fetch_project_edges
    session = StubSession(
        [
            StubResult(rows=[_ProjRow(project_id=pid)]),
            StubResult(
                rows=[
                    _TaskRow(id=t1, dependencies=[]),
                    _TaskRow(id=t2, dependencies=[t1]),
                    _TaskRow(id=t3, dependencies=[t1]),
                    _TaskRow(id=t4, dependencies=[t3]),
                ]
            ),
        ]
    )
    result = asyncio.run(analyze_downstream(session, task_id=t1))  # type: ignore[arg-type]
    assert result is not None
    assert set(result.affected_task_ids) == {t2, t3, t4}
    assert result.affected_count == 3
    assert result.root_task_id == t1


def test_analyze_downstream_none_when_task_invisible() -> None:
    """起点 task が RLS 不可視 (project_id 取得できない) なら None (→ 404)."""
    session = StubSession([StubResult(rows=None)])
    result = asyncio.run(analyze_downstream(session, task_id=str(uuid.uuid4())))  # type: ignore[arg-type]
    assert result is None


def test_analyze_downstream_leaf_has_no_descendants() -> None:
    """末端 task の affected は空。"""
    t1, t2 = str(uuid.uuid4()), str(uuid.uuid4())
    pid = str(uuid.uuid4())
    session = StubSession(
        [
            StubResult(rows=[_ProjRow(project_id=pid)]),
            StubResult(
                rows=[
                    _TaskRow(id=t1, dependencies=[]),
                    _TaskRow(id=t2, dependencies=[t1]),
                ]
            ),
        ]
    )
    result = asyncio.run(analyze_downstream(session, task_id=t2))  # type: ignore[arg-type]
    assert result is not None
    assert result.affected_task_ids == []
    assert result.affected_count == 0


def test_impact_graph_is_dag() -> None:
    """F-IMP01 前提: 影響グラフは DAG (循環なし) で descendants が有限."""
    g: nx.DiGraph[str] = nx.DiGraph()
    g.add_edges_from([("a", "b"), ("b", "c"), ("a", "c")])
    assert nx.is_directed_acyclic_graph(g)
    desc: set[str] = set(
        nx.descendants(g, "a")  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType]
    )
    assert desc == {"b", "c"}
