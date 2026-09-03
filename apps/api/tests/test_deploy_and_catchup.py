"""GAP-192 / GAP-193 の回帰テスト。

GAP-192: 本番 deploy が **migration を黙って skip しない**こと。
    従来は `PROD_DATABASE_URL` が未設定だと migration ステップが if で静かに
    飛ばされ、「新しいコードを古いスキーマの本番へ流す」= 起動後に 500 になる
    事故を CI が素通ししていた (ローカルで直した GAP-172 と同じ穴が本番に残存)。

GAP-193: PC を止めていた間に過ぎた定刻を **黙って消さない**こと。
    見張り役は 1 回だけ実行して次回時刻を今から先へ進めるので、間の回数は
    実行されない。その回数を必ず実行履歴に残す。
"""

# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
import yaml

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.services.cron.expression import missed_occurrences

REPO = Path(__file__).resolve().parents[3]
DEPLOY_WORKFLOW = REPO / ".github" / "workflows" / "deploy.yml"


class TestProductionMigrationsAreNotSkippedSilently:
    """GAP-192: 本番へ「古いスキーマのまま新しいコード」を流させない。"""

    @pytest.fixture
    def workflow(self) -> dict[str, Any]:
        assert DEPLOY_WORKFLOW.exists(), "deploy.yml が無い"
        loaded: Any = yaml.safe_load(DEPLOY_WORKFLOW.read_text())
        assert isinstance(loaded, dict)
        return loaded  # pyright: ignore[reportUnknownVariableType]

    def _steps(self, workflow: dict[str, Any]) -> list[dict[str, Any]]:
        jobs: Any = workflow["jobs"]
        return list(jobs["fly"]["steps"])

    def test_deploy_fails_when_the_db_url_is_missing(self, workflow: dict[str, Any]) -> None:
        """未設定なら deploy を **止める** (黙って skip しない)。

        どの step が見張るかは実装の都合で動く (実際に動いた)。守るのは
        「PROD_DATABASE_URL が空なら exit 1 する step がどこかにある」こと。
        """
        guards = [
            str(s.get("run", ""))
            for s in self._steps(workflow)
            if "PROD_DATABASE_URL" in str(s.get("run", "")) and "exit 1" in str(s.get("run", ""))
        ]
        assert guards, "PROD_DATABASE_URL 未設定で deploy を止める step が無い"
        assert any(
            '-z "$PROD_DATABASE_URL"' in g for g in guards
        ), "空判定をしていない (未設定でも素通りしてしまう)"

    def test_migration_step_is_not_gated_on_the_secret_being_present(
        self, workflow: dict[str, Any]
    ) -> None:
        """`if: PROD_DATABASE_URL != ''` に戻さない (それが黙って飛ばす原因だった)。"""
        for name in ("Apply DB migrations (schema-only)", "Apply DB seeds"):
            step = next(s for s in self._steps(workflow) if s.get("name") == name)
            cond = str(step.get("if", ""))
            assert "PROD_DATABASE_URL" not in cond, f"{name} が secret 有無で skip される"
            assert "skip_migrations" in cond, f"{name} の skip 条件が明示になっていない"

    def test_skipping_requires_an_explicit_opt_in(self, workflow: dict[str, Any]) -> None:
        """skip は「明示的に選んだとき」だけ (既定は必ず適用)。"""
        # workflow_dispatch の入力に skip_migrations がある
        on: Any = workflow[True] if True in workflow else workflow["on"]
        inputs: Any = on["workflow_dispatch"]["inputs"]
        assert "skip_migrations" in inputs
        assert inputs["skip_migrations"]["default"] is False

    def test_migrations_run_before_the_deploy(self, workflow: dict[str, Any]) -> None:
        """順序が逆だと「新コードが古いスキーマを触る」瞬間ができる。"""
        names = [str(s.get("name", "")) for s in self._steps(workflow)]
        assert names.index("Apply DB migrations (schema-only)") < names.index("Deploy")
        assert names.index("Apply DB seeds") < names.index("Deploy")


class TestMissedRunsAreCounted:
    """GAP-193: 取りこぼした定刻を数えられること (黙って消さないための土台)。"""

    def test_no_miss_when_it_is_just_due(self) -> None:
        due = datetime(2026, 8, 20, 0, 0, tzinfo=UTC)  # JST 09:00
        got = missed_occurrences("0 9 * * *", due_at=due, now=due)
        assert len(got) == 1  # 今回の 1 回だけ = 取りこぼし 0

    def test_three_days_off_counts_three_occurrences(self) -> None:
        """PC を 3 日止めていたら、実行されるのは 1 回・取りこぼしは 2 回。"""
        due = datetime(2026, 8, 17, 0, 0, tzinfo=UTC)  # JST 8/17 09:00
        now = datetime(2026, 8, 19, 1, 0, tzinfo=UTC)  # JST 8/19 10:00
        got = missed_occurrences("0 9 * * *", due_at=due, now=now)
        assert len(got) == 3  # 8/17, 8/18, 8/19
        # 実際に走るのは最新の 1 回。残り 2 回分が「未実行」として記録される
        assert len(got) - 1 == 2

    def test_future_due_is_not_a_miss(self) -> None:
        due = datetime(2026, 8, 21, 0, 0, tzinfo=UTC)
        now = datetime(2026, 8, 20, 0, 0, tzinfo=UTC)
        assert missed_occurrences("0 9 * * *", due_at=due, now=now) == []

    def test_long_outage_is_capped_not_unbounded(self) -> None:
        """1 か月止めていても数え上げで固まらない。"""
        due = datetime(2026, 1, 1, 0, 0, tzinfo=UTC)
        now = datetime(2026, 8, 20, 0, 0, tzinfo=UTC)
        got = missed_occurrences("0 9 * * *", due_at=due, now=now, limit=32)
        assert len(got) == 32

    def test_weekly_schedule_counts_weeks_not_days(self) -> None:
        due = datetime(2026, 8, 3, 0, 0, tzinfo=UTC)  # JST 8/3(月) 09:00
        now = datetime(2026, 8, 19, 1, 0, tzinfo=UTC)  # JST 8/19(水)
        got = missed_occurrences("0 9 * * 1", due_at=due, now=now)
        assert len(got) == 3  # 8/3, 8/10, 8/17
