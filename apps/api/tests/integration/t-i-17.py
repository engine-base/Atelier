"""T-I-17 F-IMP01 影響範囲解析 NetworkX 試験.

F-IMP01 (影響範囲解析) は services.impact が networkx DAG を構築し
descendants() で「ある変更が影響する task 群」を返す。

スケルトン: 実 impact graph 配線後にシナリオ肉付け。現状は networkx の
descendants が DAG 構造で期待通り動くことを確認。
"""

from __future__ import annotations

import networkx as nx


def test_descendants_on_simple_dag() -> None:
    """t1 → t2, t1 → t3, t3 → t4 で t1 の descendants は {t2,t3,t4}."""
    g: nx.DiGraph[str] = nx.DiGraph()
    g.add_edges_from([("t1", "t2"), ("t1", "t3"), ("t3", "t4")])
    desc = set(nx.descendants(g, "t1"))
    assert desc == {"t2", "t3", "t4"}


def test_descendants_on_leaf_returns_empty() -> None:
    g: nx.DiGraph[str] = nx.DiGraph()
    g.add_edges_from([("t1", "t2")])
    desc = set(nx.descendants(g, "t2"))
    assert desc == set()


def test_dag_is_acyclic() -> None:
    """F-IMP の前提: 影響グラフは DAG (循環なし)."""
    g: nx.DiGraph[str] = nx.DiGraph()
    g.add_edges_from([("a", "b"), ("b", "c"), ("a", "c")])
    assert nx.is_directed_acyclic_graph(g)
