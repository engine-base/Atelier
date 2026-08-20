"""GAP-194: エラーが起きたら運営に通知されることの e2e テスト (実 PG)。

**これまでの実態**: GAP-182 で public.error_log に記録はされるが、誰にも届かない。
運営が S-T05 を開きに行かない限り本番が壊れていても気づけなかった。

ここで固定する事実:
  - 新種のエラーは 1 通目が必ず対象になる
  - 同じ不具合は冷却時間の間は再通知しない (メール爆撃を起こさない)
  - 冷却後は「前回通知以降に増えた分」だけを伝える
  - 送信先未設定 / 配送失敗のときは last_notified_at を進めない (取りこぼさない)
  - 通知処理自体の失敗 (AlertDeliveryFailed) は通知しない (無限ループを作らない)
"""

# pyright: reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
from __future__ import annotations

import os
import uuid
from typing import Any

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.email import EmailSendResult
from src.observability import alerts as alerts_mod
from src.observability import notify as notify_mod
from src.observability.alerts import (
    DELIVERY_FAILED_KIND,
    build_message,
    find_candidates,
    run_error_alerts,
)
from src.observability.notify import (
    AlertSettings,
    configured_channels,
    recipients,
    send_alert,
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


def _settings(**kw: Any) -> AlertSettings:
    """テスト用の設定 (env に一切依存させない)。"""
    base: dict[str, Any] = {
        "email_to": "ops@example.com",
        "slack_webhook_url": "",
        "cooldown_minutes": 60,
        "notify_warnings": False,
        "max_per_run": 5,
        "dashboard_url": "",
    }
    base.update(kw)
    return AlertSettings(**base)


# --------------------------------------------------------------------------- #
# 送信チャネル (DB 不要)
# --------------------------------------------------------------------------- #
class TestChannels:
    def test_recipients_splits_and_trims(self) -> None:
        cfg = _settings(email_to=" a@example.com , b@example.com ,")
        assert recipients(cfg) == ("a@example.com", "b@example.com")

    def test_no_channel_when_nothing_configured(self) -> None:
        assert configured_channels(_settings(email_to="", slack_webhook_url="")) == ()

    def test_both_channels_when_configured(self) -> None:
        cfg = _settings(email_to="a@example.com", slack_webhook_url="https://hooks/x")
        assert configured_channels(cfg) == ("email", "slack")

    @pytest.mark.anyio
    async def test_send_alert_skips_when_unconfigured(self) -> None:
        """送信先が無いのに「送った」と言わない。"""
        result = await send_alert(
            title="t",
            lines=["l"],
            settings=_settings(email_to="", slack_webhook_url=""),
        )
        assert result.status == "skipped"
        assert result.channels == ()
        assert "未設定" in result.detail

    @pytest.mark.anyio
    async def test_send_alert_email_success(self, monkeypatch: pytest.MonkeyPatch) -> None:
        sent: list[Any] = []

        class _Sender:
            async def send(self, message: Any) -> EmailSendResult:
                sent.append(message)
                return EmailSendResult(id="mail-1", dry_run=False)

        monkeypatch.setattr(notify_mod, "ResendSender", lambda: _Sender())
        result = await send_alert(title="落ちた", lines=["内容: X"], settings=_settings())
        assert result.status == "sent"
        assert result.channels == ("email",)
        assert sent[0].to == ("ops@example.com",)
        assert "落ちた" in sent[0].subject
        assert "内容: X" in sent[0].text

    @pytest.mark.anyio
    async def test_send_alert_dry_run_is_not_success(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """API key 未設定の dry-run を「送信成功」に数えない (偽の成功を作らない)。"""

        class _Sender:
            async def send(self, message: Any) -> EmailSendResult:
                del message
                return EmailSendResult(id="dry-run", dry_run=True)

        monkeypatch.setattr(notify_mod, "ResendSender", lambda: _Sender())
        result = await send_alert(title="t", lines=["l"], settings=_settings())
        assert result.status == "failed"
        assert "dry-run" in result.detail

    @pytest.mark.anyio
    async def test_send_alert_survives_channel_exception(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """通知の失敗で呼び出し元を落とさない。"""

        class _Sender:
            async def send(self, message: Any) -> EmailSendResult:
                del message
                raise RuntimeError("smtp down")

        monkeypatch.setattr(notify_mod, "ResendSender", lambda: _Sender())
        result = await send_alert(title="t", lines=["l"], settings=_settings())
        assert result.status == "failed"
        assert "email 失敗" in result.detail


# --------------------------------------------------------------------------- #
# 通知対象の判定 + 送信記録 (実 PG)
# --------------------------------------------------------------------------- #
@pytest.mark.skipif(not _HAS_DB, reason="local Postgres not available")
class TestErrorAlerts:
    @pytest.fixture
    async def session(self):
        engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as s:
            yield s
        await engine.dispose()

    @staticmethod
    async def _clean(session: AsyncSession, fp: str) -> None:
        await session.execute(
            text("delete from public.error_log where fingerprint = :fp"), {"fp": fp}
        )
        await session.execute(
            text("delete from public.error_alerts where fingerprint = :fp"), {"fp": fp}
        )
        await session.commit()

    @staticmethod
    async def _log(
        session: AsyncSession,
        *,
        fp: str,
        kind: str = "ValueError",
        level: str = "error",
        minutes_ago: int = 0,
        count: int = 1,
    ) -> None:
        for _ in range(count):
            await session.execute(
                text(
                    "insert into public.error_log "
                    "(occurred_at, source, level, kind, message, path, fingerprint) "
                    "values (now() - make_interval(mins => :m), 'api', :lv, :k, "
                    "        'boom', '/x', :fp)"
                ),
                {"m": minutes_ago, "lv": level, "k": kind, "fp": fp},
            )
        await session.commit()

    @staticmethod
    async def _age_notification(session: AsyncSession, fp: str, *, minutes: int) -> None:
        """最後の通知を過去にずらす (冷却が明けた状態を作る)。"""
        await session.execute(
            text(
                "update public.error_alerts "
                "set last_notified_at = now() - make_interval(mins => :m) "
                "where fingerprint = :fp"
            ),
            {"m": minutes, "fp": fp},
        )
        await session.commit()

    @pytest.fixture
    def stub_send(self, monkeypatch: pytest.MonkeyPatch):
        """送信をスタブする。calls に (title, lines) を積む。"""
        calls: list[tuple[str, list[str]]] = []

        async def _fake(*, title: str, lines: list[str], level: str = "error", settings=None):
            del level, settings
            calls.append((title, lines))
            return notify_mod.AlertDelivery(status="sent", detail="email 送信", channels=("email",))

        monkeypatch.setattr(alerts_mod, "send_alert", _fake)
        return calls

    @pytest.mark.anyio
    async def test_new_error_is_always_a_candidate(self, session: AsyncSession) -> None:
        fp = f"t194-new-{uuid.uuid4().hex[:8]}"
        await self._clean(session, fp)
        await self._log(session, fp=fp)
        found = [
            c for c in await find_candidates(session, settings=_settings()) if c.fingerprint == fp
        ]
        assert len(found) == 1
        assert found[0].new_count == 1
        assert found[0].notified_count == 0
        await self._clean(session, fp)

    @pytest.mark.anyio
    async def test_cooldown_blocks_repeat_notification(
        self, session: AsyncSession, stub_send: list[Any]
    ) -> None:
        fp = f"t194-cool-{uuid.uuid4().hex[:8]}"
        await self._clean(session, fp)
        await self._log(session, fp=fp, count=2)
        result = await run_error_alerts(session, settings=_settings())
        assert int(result["sent"]) >= 1
        assert stub_send

        # 冷却中に同じ不具合がさらに起きても、もう送らない
        await self._log(session, fp=fp, count=3)
        again = [
            c for c in await find_candidates(session, settings=_settings()) if c.fingerprint == fp
        ]
        assert again == []
        await self._clean(session, fp)

    @pytest.mark.anyio
    async def test_after_cooldown_only_the_increase_is_reported(
        self, session: AsyncSession, stub_send: list[Any]
    ) -> None:
        fp = f"t194-inc-{uuid.uuid4().hex[:8]}"
        await self._clean(session, fp)
        # 3 時間前に 2 件 → 通知済みにする
        await self._log(session, fp=fp, count=2, minutes_ago=180)
        await run_error_alerts(session, settings=_settings())

        # 冷却が明けた状態 (通知は 2 時間前) を作り、その後に 3 件増やす
        await self._age_notification(session, fp, minutes=120)
        await self._log(session, fp=fp, count=3)
        found = [
            c for c in await find_candidates(session, settings=_settings()) if c.fingerprint == fp
        ]
        assert len(found) == 1
        assert found[0].new_count == 3
        assert found[0].notified_count == 1
        await self._clean(session, fp)

    @pytest.mark.anyio
    async def test_no_new_errors_means_no_candidate(
        self, session: AsyncSession, stub_send: list[Any]
    ) -> None:
        fp = f"t194-quiet-{uuid.uuid4().hex[:8]}"
        await self._clean(session, fp)
        await self._log(session, fp=fp, minutes_ago=180)
        await run_error_alerts(session, settings=_settings())
        # 冷却が明けても、新しいエラーが 1 件も増えていなければ通知しない
        await self._age_notification(session, fp, minutes=120)
        found = [
            c for c in await find_candidates(session, settings=_settings()) if c.fingerprint == fp
        ]
        assert found == []
        await self._clean(session, fp)

    @pytest.mark.anyio
    async def test_warning_is_not_notified_by_default(self, session: AsyncSession) -> None:
        fp = f"t194-warn-{uuid.uuid4().hex[:8]}"
        await self._clean(session, fp)
        await self._log(session, fp=fp, level="warning")
        assert [
            c for c in await find_candidates(session, settings=_settings()) if c.fingerprint == fp
        ] == []
        found = [
            c
            for c in await find_candidates(session, settings=_settings(notify_warnings=True))
            if c.fingerprint == fp
        ]
        assert len(found) == 1
        await self._clean(session, fp)

    @pytest.mark.anyio
    async def test_delivery_failure_kind_never_notifies(self, session: AsyncSession) -> None:
        """通知処理自体の失敗で通知ループを起こさない。"""
        fp = f"t194-loop-{uuid.uuid4().hex[:8]}"
        await self._clean(session, fp)
        await self._log(session, fp=fp, kind=DELIVERY_FAILED_KIND)
        assert [
            c for c in await find_candidates(session, settings=_settings()) if c.fingerprint == fp
        ] == []
        await self._clean(session, fp)

    @pytest.mark.anyio
    async def test_unconfigured_records_skipped_and_does_not_advance(
        self, session: AsyncSession
    ) -> None:
        """送信先未設定は「通知済み」にしない — 設定した後にちゃんと届く。"""
        fp = f"t194-unset-{uuid.uuid4().hex[:8]}"
        await self._clean(session, fp)
        await self._log(session, fp=fp)
        result = await run_error_alerts(
            session, settings=_settings(email_to="", slack_webhook_url="")
        )
        assert int(result["skipped"]) >= 1
        row = (
            await session.execute(
                text(
                    "select last_status, last_notified_at, notified_count "
                    "from public.error_alerts where fingerprint = :fp"
                ),
                {"fp": fp},
            )
        ).one()
        assert row.last_status == "skipped"
        assert row.last_notified_at is None
        assert row.notified_count == 0
        # 送信先を設定したら、同じエラーが対象として残っている
        found = [
            c for c in await find_candidates(session, settings=_settings()) if c.fingerprint == fp
        ]
        assert len(found) == 1
        await self._clean(session, fp)

    @pytest.mark.anyio
    async def test_delivery_failure_is_retried_next_run(
        self, session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fp = f"t194-fail-{uuid.uuid4().hex[:8]}"
        await self._clean(session, fp)
        await self._log(session, fp=fp)

        async def _fail(*, title: str, lines: list[str], level: str = "error", settings=None):
            del title, lines, level, settings
            return notify_mod.AlertDelivery(status="failed", detail="email 失敗", channels=())

        monkeypatch.setattr(alerts_mod, "send_alert", _fail)
        result = await run_error_alerts(session, settings=_settings())
        assert int(result["failed"]) >= 1
        row = (
            await session.execute(
                text(
                    "select last_status, last_notified_at from public.error_alerts "
                    "where fingerprint = :fp"
                ),
                {"fp": fp},
            )
        ).one()
        assert row.last_status == "failed"
        assert row.last_notified_at is None
        # 次回もう一度対象になる (取りこぼさない)
        assert [
            c for c in await find_candidates(session, settings=_settings()) if c.fingerprint == fp
        ]
        await self._clean(session, fp)

    @pytest.mark.anyio
    async def test_sent_records_counts(self, session: AsyncSession, stub_send: list[Any]) -> None:
        fp = f"t194-sent-{uuid.uuid4().hex[:8]}"
        await self._clean(session, fp)
        await self._log(session, fp=fp, count=4)
        await run_error_alerts(session, settings=_settings())
        row = (
            await session.execute(
                text(
                    "select last_status, notified_count, reported_errors, last_notified_at "
                    "from public.error_alerts where fingerprint = :fp"
                ),
                {"fp": fp},
            )
        ).one()
        assert row.last_status == "sent"
        assert row.notified_count == 1
        assert row.reported_errors == 4
        assert row.last_notified_at is not None
        await self._clean(session, fp)

    @pytest.mark.anyio
    async def test_max_per_run_caps_the_burst(self, session: AsyncSession) -> None:
        """一度に大量の新種が出ても、1 回の実行で送るのは上限まで。"""
        fps = [f"t194-burst-{uuid.uuid4().hex[:8]}" for _ in range(4)]
        for fp in fps:
            await self._clean(session, fp)
            await self._log(session, fp=fp)
        found = await find_candidates(session, settings=_settings(max_per_run=2))
        assert len(found) == 2
        for fp in fps:
            await self._clean(session, fp)

    @pytest.mark.anyio
    async def test_message_states_only_recorded_facts(self, session: AsyncSession) -> None:
        fp = f"t194-msg-{uuid.uuid4().hex[:8]}"
        await self._clean(session, fp)
        await self._log(session, fp=fp, count=2)
        candidate = next(
            c for c in await find_candidates(session, settings=_settings()) if c.fingerprint == fp
        )
        title, lines = build_message(candidate)
        assert "サーバー" in title
        assert "ValueError" in title
        body = "\n".join(lines)
        assert "2 件" in body
        assert "新種" in body
        assert fp in body
        await self._clean(session, fp)


# --------------------------------------------------------------------------- #
# 配線 (cron に載っていること)
# --------------------------------------------------------------------------- #
class TestWiring:
    def test_cron_schedule_registered(self) -> None:
        from src.cron.inngest_handlers import _HANDLER_MAP
        from src.cron.scheduler import CRON_SCHEDULES

        names = {s.name for s in CRON_SCHEDULES}
        assert "error-alerts" in names
        assert "error-alerts" in _HANDLER_MAP

    def test_cron_interval_does_not_add_machine_wakeups(self) -> None:
        """user-schedules と同じ 15 分間隔 = Fly.io の起動回数が増えない。"""
        from src.cron.scheduler import CRON_SCHEDULES

        by_name = {s.name: s.cron for s in CRON_SCHEDULES}
        assert by_name["error-alerts"] == by_name["user-schedules"] == "*/15 * * * *"

    def test_platform_job_meta_present(self) -> None:
        from src.services.platform_jobs import PLATFORM_JOB_META

        meta = next(m for m in PLATFORM_JOB_META if m.name == "error-alerts")
        assert "通知" in meta.title
        # 遅延があることを画面の説明でも隠さない
        assert "15 分" in meta.description
