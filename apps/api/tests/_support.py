"""テスト共有のヘルパー (pytest は test_*.py しか収集しないので実行対象外)。"""

from __future__ import annotations

from types import ModuleType

import pytest


def patch_relay_notifier(monkeypatch: pytest.MonkeyPatch, sse_relay: ModuleType) -> None:
    """GAP-202: 通知配達係を「繋がっていない」状態で差し込む。

    unit test は DB を使わない (session factory がフェイク) ので、実 DB へ
    LISTEN 接続を張らせない。繋がっていないときの再確認間隔を 0 にして、
    従来どおり即座に読みに行く挙動でテストする。

    `sse_relay` は `from src.db.notify import job_notifier` で名前を取り込んで
    いるので、**呼び出し側モジュールの属性**を差し替える必要がある。
    """
    from src.db import notify as db_notify

    notifier = db_notify.JobNotifier(dsn="")

    async def _notifier() -> db_notify.JobNotifier:
        return notifier

    monkeypatch.setattr(db_notify, "DEGRADED_RECHECK_SECONDS", 0.0)
    monkeypatch.setattr(sse_relay, "job_notifier", _notifier)
