"""GAP-195: 外形監視 (uptime) の e2e テスト (実 PG + 実 HTTP)。

**これまでの実態**: 自前のエラーログ (GAP-182/194) は**サーバーが生きている前提**
でしか書けない。Fly.io が完全に落ちたら記録も通知も残らず、復旧後に
「いつからいつまで落ちていたか」を答えられなかった。

ここで固定する事実:
  - 生きている URL / 落ちている URL を実 HTTP で正しく判定する
  - 1 回のタイムアウトで「落ちた」と決めつけない (3 回試行)
  - 通知は状態が変わった時と定期リマインドだけ (15 分ごとに送らない)
  - 通知が届かなかった観測を notified=true にしない (次に黙らない)
  - 落ちていた時間が記録に残り、24h 稼働率として読める
"""

# pyright: reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
from __future__ import annotations

import os
import threading
import uuid
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, cast

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.observability import uptime as uptime_mod
from src.observability.notify import AlertDelivery, AlertSettings
from src.observability.uptime import (
    ProbeResult,
    Target,
    TargetState,
    build_message,
    check_targets,
    parse_targets,
    previous_state,
    probe,
    should_notify,
    summarize,
    targets_from_env,
)

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")


def _db_available() -> bool:
    try:
        eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
        try:
            with eng.connect() as c:
                c.execute(text("select 1"))
        finally:
            eng.dispose()
        return True
    except Exception:
        return False


_HAS_DB = _db_available()


def _settings() -> AlertSettings:
    return AlertSettings(
        email_to="ops@example.com",
        slack_webhook_url="",
        cooldown_minutes=60,
        notify_warnings=False,
        max_per_run=5,
        dashboard_url="",
    )


class _OkHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b"down")

    def log_message(self, format: str, *args: Any) -> None:
        del format, args  # テスト中はアクセスログを出さない


@pytest.fixture(scope="module")
def live_server():
    server = HTTPServer(("127.0.0.1", 0), _OkHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


# --------------------------------------------------------------------------- #
# 対象の解釈 / 実 HTTP 判定 (DB 不要)
# --------------------------------------------------------------------------- #
class TestProbe:
    def test_parse_targets(self) -> None:
        got = parse_targets(" api=https://a/health , web=https://b ")
        assert got == [
            Target("api", "https://a/health"),
            Target("web", "https://b"),
        ]

    def test_broken_target_is_ignored_not_guessed(self) -> None:
        """書式が壊れている項目を勝手に補完しない。"""
        assert parse_targets("api,=https://x,name=") == []

    def test_targets_from_env(self) -> None:
        assert targets_from_env({"ATELIER_UPTIME_TARGETS": "api=https://a"}) == [
            Target("api", "https://a")
        ]
        assert targets_from_env({}) == []

    def test_live_url_is_ok(self, live_server: str) -> None:
        result = probe(f"{live_server}/health", attempts=1)
        assert result.ok is True
        assert result.status_code == 200
        assert result.error is None

    def test_error_status_is_down(self, live_server: str) -> None:
        result = probe(f"{live_server}/missing", attempts=1)
        assert result.ok is False
        assert result.status_code == 503
        assert "503" in (result.error or "")

    def test_unreachable_host_is_down(self) -> None:
        # 127.0.0.1:1 は誰も listen していない (接続拒否)
        result = probe("http://127.0.0.1:1/", attempts=1, timeout=1.0)
        assert result.ok is False
        assert result.status_code is None
        assert result.error

    def test_retries_before_declaring_down(self) -> None:
        """1 回のタイムアウトで「落ちた」と決めつけない。"""
        waits: list[float] = []
        result = probe(
            "http://127.0.0.1:1/", attempts=3, timeout=0.5, wait=0.01, sleep=waits.append
        )
        assert result.ok is False
        # 3 回試したので、間の待ちは 2 回
        assert len(waits) == 2


# --------------------------------------------------------------------------- #
# 通知の判定 (DB 不要)
# --------------------------------------------------------------------------- #
class TestShouldNotify:
    NOW = datetime(2026, 8, 20, 12, 0, tzinfo=UTC)

    def test_first_observation_up_is_silent(self) -> None:
        notify, _ = should_notify(
            previous=TargetState(None, None, None),
            current_ok=True,
            now=self.NOW,
            reminder_minutes=360,
        )
        assert notify is False

    def test_first_observation_down_notifies(self) -> None:
        notify, reason = should_notify(
            previous=TargetState(None, None, None),
            current_ok=False,
            now=self.NOW,
            reminder_minutes=360,
        )
        assert notify is True
        assert "初回" in reason

    def test_going_down_notifies(self) -> None:
        notify, reason = should_notify(
            previous=TargetState(True, self.NOW, None),
            current_ok=False,
            now=self.NOW,
            reminder_minutes=360,
        )
        assert (notify, reason) == (True, "落ちた")

    def test_recovery_notifies(self) -> None:
        notify, reason = should_notify(
            previous=TargetState(False, self.NOW, self.NOW),
            current_ok=True,
            now=self.NOW,
            reminder_minutes=360,
        )
        assert (notify, reason) == (True, "復旧した")

    def test_still_down_is_quiet_until_reminder(self) -> None:
        """15 分ごとに「まだ落ちています」を送らない。"""
        recent = self.NOW - timedelta(minutes=30)
        notify, _ = should_notify(
            previous=TargetState(False, recent, recent),
            current_ok=False,
            now=self.NOW,
            reminder_minutes=360,
        )
        assert notify is False

    def test_still_down_reminds_after_interval(self) -> None:
        old = self.NOW - timedelta(hours=7)
        notify, reason = should_notify(
            previous=TargetState(False, old, old),
            current_ok=False,
            now=self.NOW,
            reminder_minutes=360,
        )
        assert notify is True
        assert "リマインド" in reason

    def test_still_down_but_never_notified_notifies(self) -> None:
        """一度も届いていないなら、落ちたままでも黙らない。"""
        notify, reason = should_notify(
            previous=TargetState(False, self.NOW, None),
            current_ok=False,
            now=self.NOW,
            reminder_minutes=360,
        )
        assert notify is True
        assert "未通知" in reason

    def test_stays_quiet_while_up(self) -> None:
        notify, _ = should_notify(
            previous=TargetState(True, self.NOW, None),
            current_ok=True,
            now=self.NOW,
            reminder_minutes=360,
        )
        assert notify is False

    def test_message_states_only_facts(self) -> None:
        title, lines, level = build_message(
            target=Target("api", "https://a/health"),
            result=ProbeResult(ok=False, status_code=None, latency_ms=10, error="TimeoutError"),
            reason="落ちた",
            previous=TargetState(True, None, None),
        )
        assert "api" in title and "応答しません" in title
        assert level == "error"
        body = "\n".join(lines)
        assert "https://a/health" in body
        assert "TimeoutError" in body
        assert "3 回試行" in body

    def test_recovery_message_includes_outage_start(self) -> None:
        started = datetime(2026, 8, 20, 3, 0, tzinfo=UTC)
        title, lines, level = build_message(
            target=Target("api", "https://a/health"),
            result=ProbeResult(ok=True, status_code=200, latency_ms=120, error=None),
            reason="復旧した",
            previous=TargetState(False, started, started),
        )
        assert "復旧" in title
        assert level == "recovery"
        assert any("2026-08-20 03:00" in line for line in lines)


# --------------------------------------------------------------------------- #
# 記録 + 集計 (実 PG)
# --------------------------------------------------------------------------- #
@pytest.mark.skipif(not _HAS_DB, reason="local Postgres not available")
class TestRecording:
    @pytest.fixture
    async def session(self):
        engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as s:
            yield s
        await engine.dispose()

    @staticmethod
    async def _clean(session: AsyncSession, target: str) -> None:
        await session.execute(
            text("delete from public.uptime_checks where target = :t"), {"t": target}
        )
        await session.commit()

    @pytest.fixture
    def sent(self, monkeypatch: pytest.MonkeyPatch):
        calls: list[tuple[str, str]] = []

        async def _fake(
            *,
            title: str,
            lines: list[str],
            level: str = "error",
            settings: AlertSettings | None = None,
        ) -> AlertDelivery:
            del lines, settings
            calls.append((title, level))
            return AlertDelivery(status="sent", detail="email 送信", channels=("email",))

        monkeypatch.setattr(uptime_mod, "send_alert", _fake)
        return calls

    @pytest.mark.anyio
    async def test_live_target_is_recorded_without_notification(
        self, session: AsyncSession, live_server: str, sent: list[Any]
    ) -> None:
        name = f"t195-up-{uuid.uuid4().hex[:8]}"
        await self._clean(session, name)
        result = await check_targets(
            session,
            [Target(name, f"{live_server}/health")],
            now=datetime.now(UTC),
            settings=_settings(),
        )
        assert result["up"] == "1"
        assert result["notified"] == "0"  # 動いている初回は静かに
        row = (
            await session.execute(
                text(
                    "select ok, status_code, notified from public.uptime_checks  where target = :t"
                ),
                {"t": name},
            )
        ).one()
        assert row.ok is True
        assert row.status_code == 200
        assert row.notified is False
        await self._clean(session, name)

    @pytest.mark.anyio
    async def test_outage_is_recorded_and_notified(
        self, session: AsyncSession, live_server: str, sent: list[Any]
    ) -> None:
        name = f"t195-down-{uuid.uuid4().hex[:8]}"
        await self._clean(session, name)
        now = datetime.now(UTC)
        # 1 回目: 生きている
        await check_targets(
            session,
            [Target(name, f"{live_server}/health")],
            now=now,
            settings=_settings(),
            probe_fn=lambda _u: ProbeResult(True, 200, 90, None),
        )
        # 2 回目: 落ちた → 通知
        await check_targets(
            session,
            [Target(name, f"{live_server}/health")],
            now=now,
            settings=_settings(),
            probe_fn=lambda _u: ProbeResult(False, None, 10000, "TimeoutError"),
        )
        assert [level for _t, level in sent] == ["error"]
        # 3 回目: まだ落ちている → 通知しない (メール爆撃を起こさない)
        await check_targets(
            session,
            [Target(name, f"{live_server}/health")],
            now=now,
            settings=_settings(),
            probe_fn=lambda _u: ProbeResult(False, None, 10000, "TimeoutError"),
        )
        assert len(sent) == 1
        # 4 回目: 復旧 → 通知
        await check_targets(
            session,
            [Target(name, f"{live_server}/health")],
            now=now,
            settings=_settings(),
            probe_fn=lambda _u: ProbeResult(True, 200, 88, None),
        )
        assert [level for _t, level in sent] == ["error", "recovery"]

        rows = (
            await session.execute(
                text(
                    "select ok, notified from public.uptime_checks "
                    " where target = :t order by checked_at"
                ),
                {"t": name},
            )
        ).all()
        assert [bool(r.ok) for r in rows] == [True, False, False, True]
        assert [bool(r.notified) for r in rows] == [False, True, False, True]
        await self._clean(session, name)

    @pytest.mark.anyio
    async def test_undelivered_notification_is_not_marked_notified(
        self, session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """届かなかったものを notified=true にしない (次のリマインドで黙らない)。"""
        name = f"t195-nodeliver-{uuid.uuid4().hex[:8]}"
        await self._clean(session, name)

        async def _fail(
            *,
            title: str,
            lines: list[str],
            level: str = "error",
            settings: AlertSettings | None = None,
        ) -> AlertDelivery:
            del title, lines, level, settings
            return AlertDelivery(status="skipped", detail="送信先が未設定", channels=())

        monkeypatch.setattr(uptime_mod, "send_alert", _fail)
        await check_targets(
            session,
            [Target(name, "https://example.invalid")],
            now=datetime.now(UTC),
            settings=_settings(),
            probe_fn=lambda _u: ProbeResult(False, None, 10, "DNS"),
        )
        row = (
            await session.execute(
                text("select ok, notified from public.uptime_checks where target = :t"),
                {"t": name},
            )
        ).one()
        assert row.ok is False
        assert row.notified is False
        state = await previous_state(session, target=name)
        assert state.last_notified_at is None
        await self._clean(session, name)

    @pytest.mark.anyio
    async def test_summary_reports_availability_and_outage_start(
        self, session: AsyncSession, sent: list[Any]
    ) -> None:
        name = f"t195-sum-{uuid.uuid4().hex[:8]}"
        await self._clean(session, name)
        now = datetime.now(UTC)
        # 3 回成功 → 1 回失敗 の順に観測する
        for ok in (True, True, True, False):
            await check_targets(
                session,
                [Target(name, "https://example.invalid")],
                now=now,
                settings=_settings(),
                probe_fn=(
                    (lambda _u: ProbeResult(True, 200, 100, None))
                    if ok
                    else (lambda _u: ProbeResult(False, 500, 100, "HTTP 500"))
                ),
            )
        summary = next(s for s in await summarize(session) if s.target == name)
        assert summary.ok is False
        assert summary.checks_24h == 4
        assert summary.availability_24h == 75.0
        assert summary.since is not None  # 落ちている状態の開始時刻
        assert summary.last_error == "HTTP 500"
        await self._clean(session, name)


# --------------------------------------------------------------------------- #
# 配線 (監視 workflow が存在し、黙って skip しないこと)
# --------------------------------------------------------------------------- #
class TestWorkflow:
    @staticmethod
    def _workflow() -> dict[Any, Any]:
        import pathlib

        import yaml

        root = pathlib.Path(__file__).resolve().parents[3]
        raw = (root / ".github" / "workflows" / "uptime.yml").read_text(encoding="utf-8")
        return cast("dict[Any, Any]", yaml.safe_load(raw))

    @classmethod
    def _triggers(cls) -> dict[str, Any]:
        """PyYAML は `on:` を True (bool) として解釈する。"""
        wf = cls._workflow()
        return cast("dict[str, Any]", wf.get("on") or wf[True])

    def test_runs_on_schedule_outside_our_infra(self) -> None:
        triggers = self._triggers()
        assert triggers["schedule"] == [{"cron": "*/15 * * * *"}]
        assert "workflow_dispatch" in triggers
        assert self._workflow()["jobs"]["probe"]["runs-on"] == "ubuntu-latest"

    def test_missing_settings_fail_loudly(self) -> None:
        """設定漏れで監視が動いていない状態を黙って作らない (GAP-192 と同じ方針)。"""
        wf = self._workflow()
        verify = next(
            s for s in wf["jobs"]["probe"]["steps"] if s.get("name") == "Verify required settings"
        )
        assert "exit 1" in verify["run"]
        assert "ATELIER_UPTIME_TARGETS" in verify["run"]
        assert "PROD_DATABASE_URL" in verify["run"]

    def test_records_directly_to_db_not_through_api(self) -> None:
        """API が落ちている時に API 経由では記録できない。DB へ直接書く。"""
        wf = self._workflow()
        probe_step = next(
            s for s in wf["jobs"]["probe"]["steps"] if s.get("name") == "Probe and record"
        )
        assert "ATELIER_DB_URL" in probe_step["env"]
        assert "src.observability.uptime" in probe_step["run"]
