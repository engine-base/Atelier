"""Unit tests for apps/api/inngest_config.py."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# apps/api を sys.path に追加して inngest_config を import 可能にする
_API_ROOT = Path(__file__).resolve().parents[1]
if str(_API_ROOT) not in sys.path:
    sys.path.insert(0, str(_API_ROOT))


@pytest.mark.unit
class TestInngestConfig:
    def test_app_id_is_atelier(self) -> None:
        import inngest_config

        assert inngest_config.APP_ID == "atelier"

    def test_get_client_returns_inngest_instance(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INNGEST_DEV", "1")
        import inngest_config

        # lru_cache を clear して再生成
        inngest_config.get_client.cache_clear()
        client = inngest_config.get_client()
        assert client.app_id == "atelier"

    def test_get_client_is_cached(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INNGEST_DEV", "1")
        import inngest_config

        inngest_config.get_client.cache_clear()
        c1 = inngest_config.get_client()
        c2 = inngest_config.get_client()
        assert c1 is c2

    def test_get_client_respects_dev_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INNGEST_DEV", "true")
        monkeypatch.delenv("INNGEST_SIGNING_KEY", raising=False)
        import inngest_config

        inngest_config.get_client.cache_clear()
        # signing key 無しでも例外なく client 作成 (is_production=False のため)
        client = inngest_config.get_client()
        assert client is not None
