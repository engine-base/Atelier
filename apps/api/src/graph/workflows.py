# pyright: reportArgumentType=false, reportUnknownMemberType=false
"""LangGraph StateGraph 基盤。

NOTE: file-level pyright directive で langgraph SDK 由来の overload 型不一致と
unknown member を許容している。SDK 側の typing が整ったら撤回する。


Atelier の LLM ワークフローはすべて AtelierWorkflow を起点に構築する:
- 各 node = LLM 呼出 / human-in-the-loop / scoring / branching
- 各 edge = 状態遷移
- 中断点 (interrupt_before) で人間承認を強制
- checkpoint で再開可能

実体 (議事録解析 / 提案書生成 / コード PR 生成 等) は別 task で実装される。
本 task は基盤型と build_workflow ヘルパのみ提供する。
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import TypedDict

from langgraph.graph import END, START, StateGraph


class WorkflowState(TypedDict, total=False):
    """Atelier ワークフローの共通 State 形。

    実装側で TypedDict を拡張して固有 field を加える。
    """

    task_id: str
    employee: str
    messages: list[dict[str, str]]
    artifacts: dict[str, object]
    score: float
    requires_human_approval: bool
    error: str | None


class AtelierWorkflow:
    """LangGraph StateGraph の薄い wrapper。

    使い方:
        wf = AtelierWorkflow(name="meeting_minutes")
        wf.add_node("parse", parse_fn)
        wf.add_node("summarize", summarize_fn)
        wf.add_edge("parse", "summarize")
        wf.add_edge("summarize", END)
        wf.set_entry("parse")
        graph = wf.compile()
    """

    def __init__(self, name: str, state_schema: type[WorkflowState] = WorkflowState) -> None:
        self.name = name
        self._builder = StateGraph(state_schema)

    def add_node(
        self,
        node_name: str,
        fn: Callable[[WorkflowState], WorkflowState],
    ) -> None:
        # langgraph の StateNode は keyword-only (state: NodeInputT) シグネチャを
        # 期待するが、Atelier では positional Callable も許容するため shim。
        # langgraph add_node 自体も型情報が不完全。
        self._builder.add_node(  # pyright: ignore[reportArgumentType, reportUnknownMemberType]
            node_name,
            fn,
        )

    def add_edge(self, from_node: str, to_node: str) -> None:
        self._builder.add_edge(from_node, to_node)

    def set_entry(self, node_name: str) -> None:
        self._builder.add_edge(START, node_name)

    def compile(
        self,
        interrupt_before: Sequence[str] | None = None,
    ) -> object:
        """LangGraph CompiledStateGraph を返す。実体は langgraph.graph.state.CompiledStateGraph。"""
        kwargs: dict[str, object] = {}
        if interrupt_before:
            kwargs["interrupt_before"] = list(interrupt_before)
        return self._builder.compile(**kwargs)  # type: ignore[arg-type]


def build_workflow(
    name: str,
    nodes: dict[str, Callable[[WorkflowState], WorkflowState]],
    edges: Sequence[tuple[str, str]],
    entry: str,
    interrupt_before: Sequence[str] | None = None,
) -> AtelierWorkflow:
    """高レベル helper。dict + edges から AtelierWorkflow を構築する。

    実装側はこの関数を呼んで workflow を組み立て、wf.compile() で実行する。
    """
    wf = AtelierWorkflow(name=name)
    for node_name, fn in nodes.items():
        wf.add_node(node_name, fn)
    for src, dst in edges:
        if dst == "END":
            wf.add_edge(src, END)
        else:
            wf.add_edge(src, dst)
    wf.set_entry(entry)
    if interrupt_before:
        # compile 時に interrupt_before を反映するため state 保存
        wf._pending_interrupts = list(interrupt_before)  # type: ignore[attr-defined]
    return wf


__all__ = [
    "AtelierWorkflow",
    "WorkflowState",
    "build_workflow",
]
