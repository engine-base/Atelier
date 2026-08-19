# pyright: reportPrivateUsage=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnusedFunction=false, reportMissingTypeArgument=false
"""DB-free unit tests for services/meetings/worker (GAP-016 transcribe queue 消費者)。

外部境界 (storage DL / Whisper API / storage UL) は monkeypatch で差替え、
queue 消費のオーケストレーション (成功時の parse_result_path 差替+parsed_at
打刻+audit / 失敗時の parse_error 記録+audit / 1 件失敗で巡回が止まらない)
を実 DB 接続なしに検証する。HTTP ヘルパー自体は httpx.MockTransport で検証。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import Any, ClassVar

import httpx
import pytest

from src.services.meetings import stt, worker


@dataclass
class _Row:
    id: str
    storage_path: str = "meetings/p1/a/rec.mp3"
    file_name: str = "rec.mp3"
    mime_type: str = "audio/mpeg"
    parse_result_path: str = ""


@dataclass
class _StubResult:
    rows: list[Any] = field(default_factory=list)

    def all(self) -> list[Any]:
        return self.rows


class _StubSession:
    """execute した SQL とパラメータを記録する最小 AsyncSession 互換 stub。"""

    def __init__(self, queued_rows: list[Any] | None = None) -> None:
        self._queued_rows = list(queued_rows or [])
        self.executed: list[tuple[str, dict[str, Any]]] = []
        self.commits = 0

    async def execute(self, statement: Any, params: dict[str, Any] | None = None) -> _StubResult:
        sql = " ".join(str(statement).split())
        self.executed.append((sql, params or {}))
        if "select id, storage_path" in sql:
            return _StubResult(rows=self._queued_rows)
        return _StubResult()

    async def commit(self) -> None:
        self.commits += 1


def _run(coro: Awaitable[Any]) -> Any:
    return asyncio.new_event_loop().run_until_complete(coro)


class _AuditSpy:
    events: ClassVar[list[Any]] = []

    def __init__(self, session: Any) -> None:
        self._session = session

    async def write(self, event: Any) -> None:
        _AuditSpy.events.append(event)


@pytest.fixture(autouse=True)
def _spy_audit(monkeypatch: pytest.MonkeyPatch):
    _AuditSpy.events = []
    monkeypatch.setattr(worker, "AuditWriter", _AuditSpy)
    yield


class TestRunOnceOrchestration:
    def test_success_marks_parsed_and_audits(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mid = str(uuid.uuid4())
        session = _StubSession(queued_rows=[_Row(id=mid)])

        async def fake_download(storage_path: str) -> bytes:
            assert storage_path == "meetings/p1/a/rec.mp3"
            return b"audio-bytes"

        async def fake_whisper(*, media: bytes, file_name: str, mime_type: str) -> dict[str, Any]:
            assert media == b"audio-bytes"
            return {"text": "こんにちは", "segments": []}

        uploaded: dict[str, Any] = {}

        async def fake_upload(result_path: str, payload: dict[str, Any]) -> None:
            uploaded["path"] = result_path
            uploaded["payload"] = payload

        monkeypatch.setattr(worker, "_download_media", fake_download)
        monkeypatch.setattr(worker, "_call_whisper", fake_whisper)
        monkeypatch.setattr(worker, "_upload_result", fake_upload)

        result = _run(worker.run_once(session))  # type: ignore[arg-type]

        # GAP-177: 解析保留の再試行カウンタが増えた
        assert result["queued"] == 1 and result["processed"] == 1 and result["failed"] == 0
        assert result["analysis_retried"] == 0 and result["analysis_pending"] == 0
        assert uploaded["path"] == f"transcripts/results/{mid}.json"
        assert uploaded["payload"]["text"] == "こんにちは"
        update_sql, update_params = next(
            (s, p) for s, p in session.executed if "set parse_result_path" in s
        )
        assert "parsed_at = now()" in update_sql
        assert update_params["pp"] == f"transcripts/results/{mid}.json"
        assert session.commits == 1
        actions = [e.action for e in _AuditSpy.events]
        assert actions == ["meeting.transcribe.complete"]
        assert _AuditSpy.events[0].actor_type == "system"

    def test_failure_marks_parse_error_and_continues(self, monkeypatch: pytest.MonkeyPatch) -> None:
        bad = str(uuid.uuid4())
        good = str(uuid.uuid4())
        session = _StubSession(queued_rows=[_Row(id=bad), _Row(id=good)])

        async def fake_download(storage_path: str) -> bytes:
            return b"x"

        async def fake_whisper(*, media: bytes, file_name: str, mime_type: str) -> dict[str, Any]:
            return {"text": "ok"}

        calls = {"n": 0}

        async def flaky_upload(result_path: str, payload: dict[str, Any]) -> None:
            calls["n"] += 1
            if bad in result_path:
                raise worker.TranscribeWorkerError("storage_upload_failed", "boom")

        monkeypatch.setattr(worker, "_download_media", fake_download)
        monkeypatch.setattr(worker, "_call_whisper", fake_whisper)
        monkeypatch.setattr(worker, "_upload_result", flaky_upload)

        result = _run(worker.run_once(session))  # type: ignore[arg-type]

        # 1 件目の失敗で巡回が止まらず 2 件目は成功する
        assert result["queued"] == 2 and result["processed"] == 1 and result["failed"] == 1
        _err_sql, err_params = next(
            (s, p) for s, p in session.executed if "set parse_error = :err" in s
        )
        assert err_params["id"] == bad
        assert "storage_upload_failed" in str(err_params["err"])
        actions = sorted(e.action for e in _AuditSpy.events)
        assert actions == ["meeting.transcribe.complete", "meeting.transcribe.error"]
        # 件ごとに commit される (途中クラッシュで成功分が失われない)
        assert session.commits == 2

    def test_empty_queue_is_noop(self) -> None:
        session = _StubSession(queued_rows=[])
        result = _run(worker.run_once(session))  # type: ignore[arg-type]
        assert result["queued"] == 0 and result["processed"] == 0 and result["failed"] == 0
        assert session.commits == 0
        assert _AuditSpy.events == []


class TestRunLoop:
    def test_run_loop_once_uses_session_factory(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """--once で 1 巡だけ処理して終了する (単独プロセス経路)。"""
        import src.db as db_mod

        session = _StubSession(queued_rows=[])

        class _Factory:
            def __call__(self) -> _Factory:
                return self

            async def __aenter__(self) -> Any:
                return session

            async def __aexit__(self, *args: Any) -> None:
                return None

        monkeypatch.setattr(db_mod, "create_engine", lambda: object())
        monkeypatch.setattr(db_mod, "create_session_factory", lambda _engine: _Factory())  # pyright: ignore[reportUnknownLambdaType]
        _run(worker.run_loop(poll_interval_s=0.01, once=True))
        assert any("select id, storage_path" in s for s, _ in session.executed)


class TestQueueQuery:
    def test_list_queued_filters(self) -> None:
        session = _StubSession()
        _run(worker.list_queued(session, limit=7))  # type: ignore[arg-type]
        sql, params = session.executed[0]
        assert "parsed_at is null" in sql
        assert "parse_error is null" in sql
        assert "deleted_at is null" in sql
        assert params["prefix"] == "transcripts/queued/%"
        assert params["lim"] == 7


class TestHttpHelpers:
    def test_call_whisper_posts_multipart(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """GAP-181: API 経路は残す — 明示 opt-in したときは従来どおり動く。"""
        monkeypatch.setenv("ATELIER_OPENAI_API_KEY", "sk-test")
        monkeypatch.setenv("ATELIER_ALLOW_WHISPER_API", "1")
        monkeypatch.setenv("ATELIER_STT_PROVIDER", "openai")
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["auth"] = request.headers.get("Authorization")
            seen["body"] = request.read()
            return httpx.Response(200, json={"text": "hello", "language": "ja"})

        transport = httpx.MockTransport(handler)
        real_client = httpx.AsyncClient

        def patched_client(**kwargs: Any) -> httpx.AsyncClient:
            kwargs["transport"] = transport
            return real_client(**kwargs)

        monkeypatch.setattr(stt.httpx, "AsyncClient", patched_client)
        result = _run(worker._call_whisper(media=b"abc", file_name="a.mp3", mime_type="audio/mpeg"))
        assert result["text"] == "hello"
        assert seen["url"] == stt.WHISPER_API_URL
        assert seen["auth"] == "Bearer sk-test"
        assert b'name="model"' in seen["body"]
        assert b"whisper-1" in seen["body"]

    def test_call_whisper_without_any_provider_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """GAP-181: 経路が無いときは黙って空文字を返さず誠実に失敗する。"""
        monkeypatch.delenv("ATELIER_OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ATELIER_ALLOW_WHISPER_API", raising=False)
        monkeypatch.setattr(stt, "faster_whisper_available", lambda: False)
        with pytest.raises(worker.TranscribeWorkerError) as ei:
            _run(worker._call_whisper(media=b"x", file_name="a.mp3", mime_type="audio/mpeg"))
        assert ei.value.code == "stt_unavailable"

    def test_upload_result_upserts_json(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "http://storage.local")
        monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "srv-key")
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["upsert"] = request.headers.get("x-upsert")
            seen["body"] = request.read()
            return httpx.Response(200, json={"Key": "ok"})

        transport = httpx.MockTransport(handler)
        real_client = httpx.AsyncClient

        def patched_client(**kwargs: Any) -> httpx.AsyncClient:
            kwargs["transport"] = transport
            return real_client(**kwargs)

        monkeypatch.setattr(worker.httpx, "AsyncClient", patched_client)
        _run(worker._upload_result("transcripts/results/m1.json", {"text": "T"}))
        assert seen["url"] == "http://storage.local/storage/v1/object/transcripts/results/m1.json"
        assert seen["upsert"] == "true"
        assert b'"text": "T"' in seen["body"]

    def test_download_media_follows_signed_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def fake_sign(storage_path: str) -> str:
            assert storage_path == "meetings/p1/a/rec.mp3"
            return "http://storage.local/signed/rec.mp3?token=t"

        def handler(request: httpx.Request) -> httpx.Response:
            assert str(request.url).startswith("http://storage.local/signed/")
            return httpx.Response(200, content=b"media-bytes")

        transport = httpx.MockTransport(handler)
        real_client = httpx.AsyncClient

        def patched_client(**kwargs: Any) -> httpx.AsyncClient:
            kwargs["transport"] = transport
            return real_client(**kwargs)

        monkeypatch.setattr(worker, "create_signed_download_url", fake_sign)
        monkeypatch.setattr(worker.httpx, "AsyncClient", patched_client)
        assert _run(worker._download_media("meetings/p1/a/rec.mp3")) == b"media-bytes"

    def test_download_media_error_status_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def fake_sign(storage_path: str) -> str:
            return "http://storage.local/signed/gone.mp3"

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, text="not found")

        transport = httpx.MockTransport(handler)
        real_client = httpx.AsyncClient

        def patched_client(**kwargs: Any) -> httpx.AsyncClient:
            kwargs["transport"] = transport
            return real_client(**kwargs)

        monkeypatch.setattr(worker, "create_signed_download_url", fake_sign)
        monkeypatch.setattr(worker.httpx, "AsyncClient", patched_client)
        with pytest.raises(worker.TranscribeWorkerError) as ei:
            _run(worker._download_media("meetings/p1/a/gone.mp3"))
        assert ei.value.code == "storage_download_failed"

    def test_whisper_error_status_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ATELIER_OPENAI_API_KEY", "sk-test")
        monkeypatch.setenv("ATELIER_ALLOW_WHISPER_API", "1")
        monkeypatch.setenv("ATELIER_STT_PROVIDER", "openai")

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(429, text="rate limited")

        transport = httpx.MockTransport(handler)
        real_client = httpx.AsyncClient

        def patched_client(**kwargs: Any) -> httpx.AsyncClient:
            kwargs["transport"] = transport
            return real_client(**kwargs)

        monkeypatch.setattr(stt.httpx, "AsyncClient", patched_client)
        with pytest.raises(worker.TranscribeWorkerError) as ei:
            _run(worker._call_whisper(media=b"x", file_name="a.mp3", mime_type="audio/mpeg"))
        assert ei.value.code == "whisper_failed"


class TestGap177AnalysisRetry:
    """GAP-177: 解析だけ本人の PC (Bridge) で走る → 未接続なら保留 → 後で解析のみ再実行。

    運営 API キーをやめた代償として「PC が落ちていたら解析が永久に欠ける」劣化を
    作らないことを保証する。
    """

    def test_offline_defers_instead_of_losing_the_analysis(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        mid = str(uuid.uuid4())
        session = _StubSession(queued_rows=[_Row(id=mid)])

        async def fake_download(storage_path: str) -> bytes:
            return b"audio"

        async def fake_whisper(*, media: bytes, file_name: str, mime_type: str) -> dict[str, Any]:
            return {"text": "こんにちは", "segments": []}

        uploaded: dict[str, Any] = {}

        async def fake_upload(result_path: str, payload: dict[str, Any]) -> None:
            uploaded["payload"] = payload

        async def offline_analyze(_t: str, *, actor_id: str = "") -> dict[str, Any]:
            from src.services.meetings.analysis import AnalysisError

            raise AnalysisError("bridge_offline", "Bridge がオフラインです")

        monkeypatch.setattr(worker, "_download_media", fake_download)
        monkeypatch.setattr(worker, "_call_whisper", fake_whisper)
        monkeypatch.setattr(worker, "_upload_result", fake_upload)
        monkeypatch.setattr("src.services.meetings.analysis.analyze_transcript", offline_analyze)

        result = _run(worker.run_once(session))  # type: ignore[arg-type]

        # 文字起こしは成功扱い (再実行して二重に Whisper を叩かない)
        assert result["processed"] == 1
        assert uploaded["payload"]["text"] == "こんにちは"
        assert uploaded["payload"]["analysis_error"] == "bridge_offline"
        # 「解析だけ保留」が DB に記録されている = 永久に欠けない
        upd = [p for sql, p in session.executed if "analysis_pending_since" in sql]
        assert upd and upd[0]["pending"] is True

    def test_retry_fills_the_analysis_when_the_pc_comes_back(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """後から PC が繋がったら、解析だけやり直して保留を解除する。"""
        mid = str(uuid.uuid4())

        @dataclass
        class _PendingRow:
            id: str
            parse_result_path: str
            uploaded_by_user_id: str | None = "u-1"

        class _PendingSession(_StubSession):
            async def execute(self, statement: Any, params: dict[str, Any] | None = None):
                sql = " ".join(str(statement).split())
                self.executed.append((sql, params or {}))
                if "analysis_pending_since is not null" in sql:
                    return _StubResult(
                        rows=[
                            _PendingRow(id=mid, parse_result_path=f"transcripts/results/{mid}.json")
                        ]
                    )
                if "select id, storage_path" in sql:
                    return _StubResult(rows=[])
                return _StubResult()

        session = _PendingSession()
        saved: dict[str, Any] = {}

        async def fake_download_result(path: str) -> dict[str, Any]:
            # 前回の保存結果 (解析だけ欠けている)
            return {"text": "こんにちは", "analysis_error": "bridge_offline"}

        async def fake_upload(result_path: str, payload: dict[str, Any]) -> None:
            saved["payload"] = payload

        async def ok_analyze(_t: str, *, actor_id: str = "") -> dict[str, Any]:
            assert actor_id == "u-1"  # アップロードした本人の費用で走る
            return {"summary": "要約", "speakers": [], "requirements": [], "action_items": []}

        monkeypatch.setattr(worker, "_download_result", fake_download_result)
        monkeypatch.setattr(worker, "_upload_result", fake_upload)
        monkeypatch.setattr("src.services.meetings.analysis.analyze_transcript", ok_analyze)

        result = _run(worker.run_once(session))  # type: ignore[arg-type]

        assert result["analysis_retried"] == 1
        assert result["analysis_pending"] == 0
        # 解析が埋まり、保留マークが消えている
        assert saved["payload"]["analysis"]["summary"] == "要約"
        assert "analysis_error" not in saved["payload"]
        cleared = [p for sql, p in session.executed if "set analysis_pending_since = null" in sql]
        assert cleared and cleared[0]["id"] == mid

    def test_retry_keeps_pending_while_still_offline(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """まだ繋がっていなければ保留のまま残す (取りこぼさない)。"""
        mid = str(uuid.uuid4())

        @dataclass
        class _PendingRow:
            id: str
            parse_result_path: str
            uploaded_by_user_id: str | None = None

        class _PendingSession(_StubSession):
            async def execute(self, statement: Any, params: dict[str, Any] | None = None):
                sql = " ".join(str(statement).split())
                self.executed.append((sql, params or {}))
                if "analysis_pending_since is not null" in sql:
                    return _StubResult(
                        rows=[
                            _PendingRow(id=mid, parse_result_path=f"transcripts/results/{mid}.json")
                        ]
                    )
                if "select id, storage_path" in sql:
                    return _StubResult(rows=[])
                return _StubResult()

        session = _PendingSession()

        async def fake_download_result(path: str) -> dict[str, Any]:
            return {"text": "こんにちは", "analysis_error": "bridge_offline"}

        async def fake_upload(result_path: str, payload: dict[str, Any]) -> None:
            return None

        async def offline_analyze(_t: str, *, actor_id: str = "") -> dict[str, Any]:
            from src.services.meetings.analysis import AnalysisError

            raise AnalysisError("bridge_offline", "まだオフライン")

        monkeypatch.setattr(worker, "_download_result", fake_download_result)
        monkeypatch.setattr(worker, "_upload_result", fake_upload)
        monkeypatch.setattr("src.services.meetings.analysis.analyze_transcript", offline_analyze)

        result = _run(worker.run_once(session))  # type: ignore[arg-type]

        assert result["analysis_retried"] == 0
        assert result["analysis_pending"] == 1
        assert not [p for sql, p in session.executed if "set analysis_pending_since = null" in sql]
