"""Inngest client 初期化。

`selected-stack.json#queue = "Inngest (Phase 4+) + pg_cron (Phase 0-3)"` の通り、
Phase 4 以降は Inngest cron / async job プラットフォームを利用する。

本 task は Inngest client の最低限の bootstrap を提供する。
個別 function の登録は T-F-20 (cron 基盤) で実装する。

環境変数:
  INNGEST_EVENT_KEY: prod 環境では Inngest cloud の event key
  INNGEST_SIGNING_KEY: prod 環境では Inngest cloud の signing key
  INNGEST_DEV: '1' なら開発モード (signing key 不要)
"""

from __future__ import annotations

import os
from functools import lru_cache

import inngest

APP_ID = "atelier"


@lru_cache(maxsize=1)
def get_client() -> inngest.Inngest:
    """Inngest client (singleton)。プロセスで 1 つだけ作成する。"""
    is_dev = os.environ.get("INNGEST_DEV", "").lower() in ("1", "true", "yes")
    return inngest.Inngest(
        app_id=APP_ID,
        event_key=os.environ.get("INNGEST_EVENT_KEY"),
        signing_key=os.environ.get("INNGEST_SIGNING_KEY"),
        is_production=not is_dev,
    )


__all__ = ["APP_ID", "get_client"]
