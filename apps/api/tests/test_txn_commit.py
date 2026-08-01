"""CommitBeforeResponseMiddleware (read-your-own-write 整合) の回帰テスト。

S-H01 design-audit で検出した race の再発防止:
POST /mocks → 201 の直後に client が送る POST /mocks/{id}/versions が、
teardown commit (レスポンス送信後) より先に到着して間欠 404 になっていた。
middleware が http.response.start 転送「前」に commit することを検証する。
"""

from __future__ import annotations

from typing import Any

import pytest
from starlette.types import Message

from main import app
from src.txn_commit import CommitBeforeResponseMiddleware, current_rls_session


class FakeSession:
    def __init__(self) -> None:
        self.commits = 0

    async def commit(self) -> None:
        self.commits += 1


def _http_scope() -> dict[str, Any]:
    return {"type": "http", "method": "POST", "path": "/x", "headers": []}


async def _receive() -> dict[str, Any]:  # pragma: no cover - 呼ばれない
    return {"type": "http.request"}


def _app_sending(status: int, headers: list[tuple[bytes, bytes]], session: FakeSession | None):
    """response.start/body を送る最小 ASGI app。send 前に contextvar を登録する。"""

    async def asgi(scope: Any, receive: Any, send: Any) -> None:
        token = current_rls_session.set(session)  # type: ignore[arg-type]
        try:
            await send({"type": "http.response.start", "status": status, "headers": headers})
            await send({"type": "http.response.body", "body": b"{}"})
        finally:
            current_rls_session.reset(token)

    return asgi


async def _run(
    status: int,
    headers: list[tuple[bytes, bytes]],
    session: FakeSession | None,
) -> list[tuple[str, int]]:
    """middleware を通し、(event, その時点の commit 回数) の並びを返す。"""
    events: list[tuple[str, int]] = []

    async def send(message: Message) -> None:
        events.append((message["type"], session.commits if session else -1))

    mw = CommitBeforeResponseMiddleware(_app_sending(status, headers, session))
    await mw(_http_scope(), _receive, send)
    return events


@pytest.mark.asyncio
async def test_commits_before_forwarding_response_start() -> None:
    """2xx JSON 応答: response.start が下流に届く前に commit 済みであること。"""
    session = FakeSession()
    events = await _run(201, [(b"content-type", b"application/json")], session)
    # 下流が response.start を観測した時点で commits == 1 (送信前に commit 済み)
    assert events[0] == ("http.response.start", 1)
    assert session.commits == 1


@pytest.mark.asyncio
async def test_no_commit_on_error_response() -> None:
    """4xx 応答: rollback は teardown 側の責務 — middleware は commit しない。"""
    session = FakeSession()
    events = await _run(404, [(b"content-type", b"application/json")], session)
    assert events[0] == ("http.response.start", 0)
    assert session.commits == 0


@pytest.mark.asyncio
async def test_no_commit_on_sse_response() -> None:
    """SSE: ストリーム本体が session を使うため commit しない (RLS 失効防止)。"""
    session = FakeSession()
    events = await _run(200, [(b"content-type", b"text/event-stream")], session)
    assert events[0] == ("http.response.start", 0)
    assert session.commits == 0


@pytest.mark.asyncio
async def test_passthrough_without_session() -> None:
    """セッション未登録のリクエスト (認証前エンドポイント等) は素通し。"""
    events = await _run(200, [(b"content-type", b"application/json")], None)
    assert [e for e, _ in events] == ["http.response.start", "http.response.body"]


def test_middleware_is_installed_on_app() -> None:
    """main.app に middleware が登録されていること (外し忘れ検知)。"""
    assert any(m.cls is CommitBeforeResponseMiddleware for m in app.user_middleware)
