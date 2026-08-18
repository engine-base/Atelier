"""GAP-137: モック取り込み (artifacts) の DB 非依存 unit tests。

画面名導出 / 自己署名トークン / 作業フォルダの成果物検出を検証する。
DB 込みの取り込みと配信は tests/routes/test_chat_artifacts.py が担当。
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.services.chat_sse.pc_artifacts import collect_new_html, snapshot_html_files
from src.services.mocks.artifacts import (
    build_content_url,
    derive_screen_name,
    sign_content_token,
    verify_content_token,
)


class TestDeriveScreenName:
    def test_title_tag_wins(self) -> None:
        html = "<html><head><title>  LP トップ  </title></head><body/></html>"
        assert derive_screen_name("index.html", html) == "LP トップ"

    def test_falls_back_to_file_stem(self) -> None:
        assert derive_screen_name("sub/pricing.html", "<html/>") == "pricing"
        assert derive_screen_name("A.HTM", "<html><title></title></html>") == "A"

    def test_never_empty_and_capped(self) -> None:
        assert derive_screen_name(".html", "<html/>") == "untitled"
        long = "x" * 300
        assert len(derive_screen_name("a.html", f"<title>{long}</title>")) == 80


class TestContentToken:
    def test_sign_and_verify_roundtrip(self) -> None:
        exp = int(time.time()) + 60
        sig = sign_content_token("mock-1", exp)
        assert verify_content_token("mock-1", exp, sig) is True

    def test_rejects_expired_and_tampered(self) -> None:
        past = int(time.time()) - 1
        assert verify_content_token("mock-1", past, sign_content_token("mock-1", past)) is False
        exp = int(time.time()) + 60
        assert verify_content_token("mock-2", exp, sign_content_token("mock-1", exp)) is False
        assert verify_content_token("mock-1", exp, "deadbeef") is False

    def test_build_content_url_shape(self) -> None:
        url = build_content_url("http://api.example/", "m-1")
        assert url.startswith("http://api.example/mocks/m-1/content?exp=")
        assert "&sig=" in url


class TestWorkspaceDetection:
    def test_collects_only_new_or_updated_html(self, tmp_path: Path) -> None:
        old = tmp_path / "old.html"
        old.write_text("<html>old</html>")
        os.utime(old, (1_000_000, 1_000_000))
        before = snapshot_html_files(str(tmp_path))

        (tmp_path / "new.html").write_text("<html><title>New</title></html>")
        os.utime(tmp_path / "new.html", (3_000_000, 3_000_000))
        (tmp_path / "note.txt").write_text("ignore")
        sub = tmp_path / "node_modules"
        sub.mkdir()
        (sub / "skip.html").write_text("<html>skip</html>")

        files = collect_new_html(str(tmp_path), before)
        assert [name for name, _ in files] == ["new.html"]
        assert "<title>New</title>" in files[0][1]

    def test_updated_file_is_collected(self, tmp_path: Path) -> None:
        page = tmp_path / "page.html"
        page.write_text("<html>v1</html>")
        os.utime(page, (1_000_000, 1_000_000))
        before = snapshot_html_files(str(tmp_path))
        page.write_text("<html>v2</html>")
        os.utime(page, (2_000_000, 2_000_000))
        files = collect_new_html(str(tmp_path), before)
        assert [name for name, _ in files] == ["page.html"]

    def test_missing_root_is_empty(self, tmp_path: Path) -> None:
        assert snapshot_html_files(str(tmp_path / "none")) == {}
        assert collect_new_html(str(tmp_path / "none"), {}) == []


@pytest.mark.asyncio
async def test_relay_adapter_maps_artifact_chunks(monkeypatch: pytest.MonkeyPatch) -> None:
    """GAP-137: kind='artifact' の chunk が {"artifact": {...}} で SSE 側に流れる。"""
    from typing import Any

    from src.services import chat_relay as relay_svc
    from src.services.chat_sse import relay as sse_relay

    class _FakeSession:
        async def __aenter__(self) -> Any:
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

        async def commit(self) -> None: ...

    state: dict[str, Any] = {"status": "running", "chunks": []}
    monkeypatch.setattr(sse_relay, "_session_factory", lambda: _FakeSession)
    monkeypatch.setattr(sse_relay, "_POLL_INTERVAL_SECONDS", 0.0)

    async def _online(_s: Any) -> bool:
        return True

    async def _enqueue(_s: Any, **_k: Any) -> str:
        return "job-1"

    async def _fetch(_s: Any, *, job_id: str, after_seq: int) -> list[tuple[int, str, str]]:
        return [c for c in state["chunks"] if c[0] > after_seq]

    async def _result(_s: Any, *, job_id: str) -> tuple[str, str | None]:
        return state["status"], None

    monkeypatch.setattr(relay_svc, "worker_online", _online)
    monkeypatch.setattr(relay_svc, "enqueue_job", _enqueue)
    monkeypatch.setattr(relay_svc, "fetch_chunks", _fetch)
    monkeypatch.setattr(relay_svc, "job_result", _result)

    state["chunks"] = [
        (0, "delta", "できました"),
        (1, "artifact", '{"mock_id": "m-1", "screen_name": "LP", "version": 2}'),
        (2, "artifact", "broken json"),  # 壊れた行は落とす (イベントに化けない)
    ]
    state["status"] = "done"
    out = [
        c
        async for c in sse_relay.relay_stream_chunks(
            system_prompt="SYS",
            history=[],
            user_message="LP作って",
            thread_id="t1",
            actor_id="u1",
            tools_mode="auto",
        )
    ]
    assert "できました" in out
    assert {"artifact": {"mock_id": "m-1", "screen_name": "LP", "version": 2}} in out
    assert all(not (isinstance(c, dict) and "artifact" in c and c["artifact"] == "broken json") for c in out)
    assert len([c for c in out if isinstance(c, dict) and "artifact" in c]) == 1
