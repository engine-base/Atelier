"""GAP-206: 混雑（順番待ち・お断り）が起きたら知らせる。

**これまでの実態**:
    GAP-203 で「断らずに並ばせる」ようにしたが、**並んだこと自体は運営画面を
    見に行かないと分からなかった**。しかも順番待ちの数字はプロセス内の
    カウンタなので machine ごとに別々で、cron は 1 台でしか動かないため
    「もう 1 台で起きた混雑」には構造的に気づけなかった。

ここで固定する事実:
  - 混雑が **起きた瞬間に** 1 行残る（あとから数えるのではない）
  - **machine をまたいで**集計される
  - 送信先が未設定なら **送ったふりをしない**（skipped として残す）
  - 送信に失敗したら `last_notified_at` を進めない（次回再試行）
  - 冷却時間内は再通知しない（鳴りっぱなしにしない）
  - 断ったときと待たせただけのときで **本文が変わる**（対応が違うため）
"""

from __future__ import annotations

import datetime as dt
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.pool import NullPool

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")
PG_URL = "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
os.environ.setdefault("ATELIER_DB_URL", PG_URL)

from src.db.session import (  # noqa: E402 - env を先に立ててから読む
    DatabaseSettings,
    create_engine,
    create_session_factory,
)
from src.observability import capacity_alerts as ca  # noqa: E402
from src.observability.notify import AlertDelivery, AlertSettings  # noqa: E402
from src.services.chat_sse.capacity import StreamCapacity  # noqa: E402


def _db_available() -> bool:
    try:
        eng = sqlalchemy.create_engine(PG_URL.replace("+asyncpg", "+psycopg"), poolclass=NullPool)
        try:
            with eng.connect() as c:
                c.execute(text("select 1"))
        finally:
            eng.dispose()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="local Postgres not available")

Factory = async_sessionmaker[AsyncSession]

INSERT_EVENT = (
    "insert into public.capacity_events"
    " (kind, machine_id, open_streams, stream_limit, queued, queue_limit)"
    " values (:k, :m, 1000, 1000, :q, 2000)"
)


@asynccontextmanager
async def clean_db() -> AsyncGenerator[Factory, None]:
    """**テストと同じ event loop で** engine を作る。

    async fixture にすると fixture 側とテスト側で loop が分かれ、asyncpg の
    接続が別ループに紐づいて壊れる（GAP-202 でも踏んだ）。
    """
    engine = create_engine(DatabaseSettings(url=PG_URL))
    factory = create_session_factory(engine)
    try:
        async with factory() as s:  # 前のテストの残骸を消す
            await s.execute(text("delete from public.capacity_events"))
            await s.execute(text("delete from public.capacity_alert_state"))
            await s.commit()
        yield factory
    finally:
        await engine.dispose()


def _snapshot(**kw: int) -> StreamCapacity:
    base: dict[str, int] = {
        "open_streams": 1000,
        "limit": 1000,
        "rejected": 0,
        "queued": 3,
        "queue_limit": 2000,
        "queued_total": 3,
    }
    base.update(kw)
    return StreamCapacity(**base)  # type: ignore[arg-type]


def _no_channels() -> AlertSettings:
    """送信先が 1 つも設定されていない状態。"""
    return AlertSettings(email_to="", slack_webhook_url="")  # type: ignore[call-arg]


def _with_email() -> AlertSettings:
    """送信先が設定されている状態。"""
    return AlertSettings(email_to="ops@example.test", slack_webhook_url="")  # type: ignore[call-arg]


def _candidate(kind: str, **kw: object) -> ca.CapacityCandidate:
    now = dt.datetime.now(tz=dt.UTC)
    base: dict[str, object] = {
        "kind": kind,
        "events": 1,
        "machines": 1,
        "first_at": now,
        "last_at": now,
        "peak_queued": 3,
        "stream_limit": 1000,
        "samples": [],
    }
    base.update(kw)
    return ca.CapacityCandidate(**base)  # type: ignore[arg-type]


class TestRecording:
    @pytest.mark.anyio
    async def test_event_is_recorded_at_the_moment(self) -> None:
        """**起きた瞬間に**残る（あとから数えるのではない）。"""
        async with clean_db() as factory:
            await ca.record_capacity_event(factory, "queued", _snapshot(), "3 人目")
            async with factory() as s:
                row = (
                    await s.execute(
                        text(
                            "select kind, machine_id, open_streams, stream_limit, queued, detail"
                            " from public.capacity_events"
                        )
                    )
                ).one()
        assert row.kind == "queued"
        assert row.open_streams == 1000
        assert row.queued == 3
        assert row.detail == "3 人目"
        assert row.machine_id  # 空でない (local か Fly の ID)

    def test_machine_id_falls_back_to_local(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("FLY_MACHINE_ID", raising=False)
        assert ca.machine_id() == "local"
        monkeypatch.setenv("FLY_MACHINE_ID", "abc123")
        assert ca.machine_id() == "abc123"


class TestAggregation:
    @pytest.mark.anyio
    async def test_counts_across_machines(self) -> None:
        """**machine をまたいで**集計される（1 台からしか見えない、を無くす）。"""
        async with clean_db() as factory, factory() as s:
            for machine in ("m1", "m1", "m2"):
                await s.execute(text(INSERT_EVENT), {"k": "queued", "m": machine, "q": 5})
            await s.commit()
            found = await ca.find_capacity_candidates(s)
        assert len(found) == 1
        assert found[0].kind == "queued"
        assert found[0].events == 3
        assert found[0].machines == 2, "machine をまたげていない"
        assert found[0].peak_queued == 5

    @pytest.mark.anyio
    async def test_separates_queued_from_rejected(self) -> None:
        """待たせただけと断ったのは**別扱い**（対応が違うため）。"""
        async with clean_db() as factory, factory() as s:
            await s.execute(text(INSERT_EVENT), {"k": "queued", "m": "m1", "q": 1})
            await s.execute(text(INSERT_EVENT), {"k": "rejected", "m": "m1", "q": 2000})
            await s.commit()
            found = await ca.find_capacity_candidates(s)
        assert {c.kind for c in found} == {"queued", "rejected"}


class TestMessage:
    def test_rejected_says_the_user_could_not_run(self) -> None:
        """断ったときは「実行できなかった」とはっきり書く。"""
        title, lines = ca.build_capacity_message(_candidate("rejected", events=2, peak_queued=2000))
        body = "\n".join(lines)
        assert "お断り" in title
        assert "実行できませんでした" in body
        assert "打った文章は消えていません" in body
        assert "scaling-runbook" in body

    def test_queued_says_nobody_was_refused(self) -> None:
        """待たせただけなら「断ってはいない」と書く（過剰に不安にしない）。"""
        _title, lines = ca.build_capacity_message(_candidate("queued"))
        body = "\n".join(lines)
        assert "断ってはいません" in body
        assert "実行できませんでした" not in body


class TestDelivery:
    @pytest.mark.anyio
    async def test_no_channels_is_skipped_not_pretended(self) -> None:
        """送信先が無いときに **送ったふりをしない**。"""
        async with clean_db() as factory, factory() as s:
            await s.execute(text(INSERT_EVENT), {"k": "queued", "m": "m1", "q": 1})
            await s.commit()
            result = await ca.run_capacity_alerts(s, settings=_no_channels())
            state = (
                await s.execute(
                    text(
                        "select kind, last_notified_at, last_status"
                        " from public.capacity_alert_state"
                    )
                )
            ).one()
        assert result["skipped"] == "1"
        assert result["sent"] == "0"
        assert state.last_status == "skipped"
        assert state.last_notified_at is None, "送っていないのに時刻を進めてはいけない"

    @pytest.mark.anyio
    async def test_nothing_to_report_is_cheap(self) -> None:
        async with clean_db() as factory, factory() as s:
            result = await ca.run_capacity_alerts(s, settings=_no_channels())
        assert result["candidates"] == "0"

    @pytest.mark.anyio
    async def test_cooldown_prevents_repeat(self) -> None:
        """一度知らせたら、冷却時間の間は鳴らさない。"""
        async with clean_db() as factory, factory() as s:
            await s.execute(text(INSERT_EVENT), {"k": "queued", "m": "m1", "q": 1})
            await s.execute(
                text(
                    "insert into public.capacity_alert_state"
                    " (kind, last_notified_at, notified_count, last_status)"
                    " values ('queued', now(), 1, 'sent')"
                )
            )
            await s.commit()
            found = await ca.find_capacity_candidates(s)
        assert found == [], "冷却時間内なのに再通知しようとしている"

    @pytest.mark.anyio
    async def test_after_cooldown_new_events_are_reported(self) -> None:
        """冷却が明けて **その後に起きた** 分だけ知らせる。"""
        async with clean_db() as factory, factory() as s:
            await s.execute(
                text(
                    "insert into public.capacity_alert_state"
                    " (kind, last_notified_at, notified_count, last_status)"
                    " values ('queued', now() - interval '2 hours', 1, 'sent')"
                )
            )
            # 通知より前の出来事 (もう知らせた分) と、後の出来事
            await s.execute(
                text(
                    "insert into public.capacity_events"
                    " (kind, machine_id, open_streams, stream_limit, queued, queue_limit,"
                    "  occurred_at)"
                    " values ('queued', 'm1', 1000, 1000, 1, 2000, now() - interval '3 hours'),"
                    "        ('queued', 'm1', 1000, 1000, 9, 2000, now())"
                )
            )
            await s.commit()
            found = await ca.find_capacity_candidates(s)
        assert len(found) == 1
        assert found[0].events == 1, "既に知らせた分まで数え直している"
        assert found[0].peak_queued == 9


class TestSending:
    """**実際に送る経路**も固定する (送信先が無い場合だけ試して満足しない)。"""

    @pytest.mark.anyio
    async def test_sent_advances_the_clock_and_carries_the_body(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        sent: list[tuple[str, list[str]]] = []

        async def fake_send(
            *, title: str, lines: list[str], level: str, settings: object
        ) -> AlertDelivery:
            del level, settings
            sent.append((title, lines))
            return AlertDelivery(status="sent", detail="email", channels=("email",))

        monkeypatch.setattr(ca, "send_alert", fake_send)
        async with clean_db() as factory, factory() as s:
            await s.execute(text(INSERT_EVENT), {"k": "rejected", "m": "m1", "q": 2000})
            await s.commit()
            result = await ca.run_capacity_alerts(s, settings=_with_email())
            state = (
                await s.execute(
                    text(
                        "select last_notified_at, notified_count, last_status, last_detail"
                        " from public.capacity_alert_state where kind = 'rejected'"
                    )
                )
            ).one()
        assert result["sent"] == "1"
        assert len(sent) == 1, "1 通も送っていない"
        assert "お断り" in sent[0][0], "件名が種類を表していない"
        assert state.last_notified_at is not None, "送ったのに時刻が進んでいない"
        assert state.notified_count == 1
        assert state.last_status == "sent"
        assert state.last_detail == "email"

    @pytest.mark.anyio
    async def test_failed_does_not_advance_the_clock(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """**届いていないのに「通知済み」にしない** (設定した瞬間に 1 通目が届く)。"""

        async def fake_send(
            *, title: str, lines: list[str], level: str, settings: object
        ) -> AlertDelivery:
            del title, lines, level, settings
            return AlertDelivery(status="failed", detail="smtp down", channels=("email",))

        monkeypatch.setattr(ca, "send_alert", fake_send)
        async with clean_db() as factory, factory() as s:
            await s.execute(text(INSERT_EVENT), {"k": "queued", "m": "m1", "q": 3})
            await s.commit()
            result = await ca.run_capacity_alerts(s, settings=_with_email())
            state = (
                await s.execute(
                    text(
                        "select last_notified_at, notified_count, last_status"
                        " from public.capacity_alert_state where kind = 'queued'"
                    )
                )
            ).one()
            # 次回また対象になる (取りこぼさない)
            again = await ca.find_capacity_candidates(s)
        assert result["failed"] == "1" and result["sent"] == "0"
        assert state.last_notified_at is None, "失敗したのに時刻を進めている"
        assert state.notified_count == 0
        assert state.last_status == "failed"
        assert len(again) == 1, "失敗した分が次回の対象から消えている"


class TestRetention:
    @pytest.mark.anyio
    async def test_old_events_are_purged_but_recent_ones_stay(self) -> None:
        """**無限に太らせない** — 保持期間を過ぎた分だけ消す。"""
        async with clean_db() as factory, factory() as s:
            await s.execute(
                text(
                    "insert into public.capacity_events"
                    " (kind, machine_id, open_streams, stream_limit, queued, queue_limit,"
                    "  occurred_at)"
                    " values ('queued', 'm1', 1, 1, 1, 2, now() - interval '200 days'),"
                    "        ('queued', 'm1', 1, 1, 1, 2, now())"
                )
            )
            await s.commit()
            purged = await ca.purge_old_capacity_events(s, days=90)
            await s.commit()
            left = (
                await s.execute(text("select count(*) from public.capacity_events"))
            ).scalar_one()
        assert purged == 1, "古い記録が消えていない"
        assert left == 1, "最近の記録まで消している"

    def test_purge_rides_the_existing_cleanup_job(self) -> None:
        """**専用 cron を足していない** (足すと machine 起動 = 課金が増える)。"""
        import pathlib

        jobs = (
            pathlib.Path(__file__).resolve().parents[1]
            / "src"
            / "services"
            / "platform_jobs"
            / "__init__.py"
        ).read_text(encoding="utf-8")
        assert "purge_old_capacity_events" in jobs, "既存の掃除ジョブから呼ばれていない"


class TestCronWiring:
    def test_capacity_alerts_ride_the_existing_cron(self) -> None:
        """**machine の起床回数を増やさない** — 既存 cron に相乗りしていること。"""
        import pathlib

        root = pathlib.Path(__file__).resolve().parents[1] / "src" / "cron"
        handlers = (root / "inngest_handlers.py").read_text(encoding="utf-8")
        assert "run_capacity_alerts" in handlers, "cron から呼ばれていない"
        # 専用 cron を足していないこと (足すと machine 起動回数 = 課金が増える)
        schedules = (root / "scheduler.py").read_text(encoding="utf-8")
        assert "capacity-alerts" not in schedules, "専用 cron を足すと machine 起動が増える"


class TestRecorderIsInstalled:
    def test_app_startup_installs_the_recorder(self) -> None:
        """記録先がアプリ起動時に差し込まれていること (差さないと何も残らない)。"""
        import pathlib

        main = (pathlib.Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8")
        assert "set_event_recorder" in main
        assert "record_capacity_event" in main


class TestAdminScreenShowsHistory:
    """GAP-208: 通知を入れない判断になったので、**画面が唯一の気づく場所**になる。

    S-T01 の「同時チャット」行はこの要求を処理した machine のプロセス内カウンタ
    なので、2 台目で起きた混雑は映らない。machine 横断の実績を別の行で出す。
    """

    @pytest.mark.anyio
    async def test_history_row_counts_across_machines(self) -> None:
        from src.services.admin.ops import get_health

        async with clean_db() as factory, factory() as s:
            await s.execute(text(INSERT_EVENT), {"k": "queued", "m": "m1", "q": 3})
            await s.execute(text(INSERT_EVENT), {"k": "queued", "m": "m2", "q": 9})
            await s.execute(text(INSERT_EVENT), {"k": "rejected", "m": "m2", "q": 2000})
            await s.commit()
            rows = await get_health()

        row = next((r for r in rows if "混雑の実績" in r.name), None)
        assert row is not None, "混雑実績の行が画面に出ていない"
        assert "順番待ち 2 回" in row.detail
        assert "最大 9 人待ち" in row.detail
        assert "お断り 1 回" in row.detail
        assert "2 台で発生" in row.detail, "machine をまたげていない"
        # お断りが出ているなら、待たせただけより強い表示にする
        assert row.status == "err"
        assert "machine を増やす" in row.meta

    @pytest.mark.anyio
    async def test_history_row_is_quiet_when_nothing_happened(self) -> None:
        from src.services.admin.ops import get_health

        async with clean_db():
            rows = await get_health()
        row = next((r for r in rows if "混雑の実績" in r.name), None)
        assert row is not None
        assert row.status == "ok"
        assert "混雑なし" in row.detail
