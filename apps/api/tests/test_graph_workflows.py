"""Unit tests for apps/api/src/graph/workflows.py."""

from __future__ import annotations

import pytest

from src.graph import AtelierWorkflow, WorkflowState, build_workflow


def _noop(state: WorkflowState) -> WorkflowState:
    return state


@pytest.mark.unit
class TestAtelierWorkflow:
    def test_constructs_with_name(self) -> None:
        wf = AtelierWorkflow(name="test_wf")
        assert wf.name == "test_wf"

    def test_add_node_and_edge_and_compile(self) -> None:
        wf = AtelierWorkflow(name="simple")
        wf.add_node("a", _noop)
        wf.add_node("b", _noop)
        wf.add_edge("a", "b")
        wf.set_entry("a")
        graph = wf.compile()
        assert graph is not None

    def test_compile_with_interrupt(self) -> None:
        wf = AtelierWorkflow(name="with_interrupt")
        wf.add_node("approval", _noop)
        wf.set_entry("approval")
        graph = wf.compile(interrupt_before=["approval"])
        assert graph is not None


@pytest.mark.unit
class TestBuildWorkflow:
    def test_builds_from_dict(self) -> None:
        wf = build_workflow(
            name="dict_build",
            nodes={"start": _noop, "end_node": _noop},
            edges=[("start", "end_node"), ("end_node", "END")],
            entry="start",
        )
        assert isinstance(wf, AtelierWorkflow)
        assert wf.name == "dict_build"
        graph = wf.compile()
        assert graph is not None

    def test_builds_with_interrupt(self) -> None:
        wf = build_workflow(
            name="interrupt_build",
            nodes={"step1": _noop, "approval": _noop},
            edges=[("step1", "approval"), ("approval", "END")],
            entry="step1",
            interrupt_before=["approval"],
        )
        assert hasattr(wf, "_pending_interrupts")


@pytest.mark.unit
class TestWorkflowState:
    def test_total_false_allows_partial_state(self) -> None:
        # TypedDict total=False なので部分的 state も許容される
        state: WorkflowState = {"task_id": "T-F-13"}
        assert state["task_id"] == "T-F-13"

    def test_full_state_supports_all_fields(self) -> None:
        state: WorkflowState = {
            "task_id": "T-F-13",
            "employee": "tony",
            "messages": [{"role": "user", "content": "hi"}],
            "artifacts": {"key": "value"},
            "score": 0.95,
            "requires_human_approval": False,
            "error": None,
        }
        assert state["score"] == 0.95
        assert state["requires_human_approval"] is False
