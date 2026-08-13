"""T-F-42: Sentry が API の**実行経路**から初期化されることの検証。

T-F-08 は `init_sentry()` を実装したが呼び出し元がテストだけで、本番 API は
Sentry 未初期化のままだった (GAP-108)。ここでは「定義がある」ではなく
「lifespan から実際に呼ばれ、初期化状態になる」ことを検証する。

sentry-sdk は optional dep (未インストール) なので、SDK 有りの経路は
`sys.modules` に fake を差し込んで実行する。
"""

# pyright: reportPrivateUsage=false, reportUnusedFunction=false
from __future__ import annotations

import inspect
import sys
import types
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

import main as main_mod
import src.observability.sentry as sentry_mod
from src.observability import is_sentry_initialized


@pytest.fixture(autouse=True)
def _reset_initialized() -> None:
    """各テスト前に idempotent guard をリセットする。"""
    sentry_mod._initialized = False


class _FakeSentrySdk:
    """`sentry_sdk.init` の呼び出し回数と引数を記録する fake。"""

    def __init__(self) -> None:
        self.init_calls: list[dict[str, Any]] = []

    def init(self, **kwargs: Any) -> None:
        self.init_calls.append(kwargs)


def _install_fake_sentry_sdk(monkeypatch: pytest.MonkeyPatch) -> _FakeSentrySdk:
    """`sentry_sdk` とその FastAPI / Starlette integration を sys.modules に差し込む。"""
    fake = _FakeSentrySdk()

    sdk_module = types.ModuleType("sentry_sdk")
    sdk_module.init = fake.init  # type: ignore[attr-defined]

    integrations = types.ModuleType("sentry_sdk.integrations")
    fastapi_mod = types.ModuleType("sentry_sdk.integrations.fastapi")
    starlette_mod = types.ModuleType("sentry_sdk.integrations.starlette")

    class _Integration:
        def __init__(self, **kwargs: Any) -> None:
            self.kwargs = kwargs

    fastapi_mod.FastApiIntegration = _Integration  # type: ignore[attr-defined]
    starlette_mod.StarletteIntegration = _Integration  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "sentry_sdk", sdk_module)
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations", integrations)
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations.fastapi", fastapi_mod)
    monkeypatch.setitem(sys.modules, "sentry_sdk.integrations.starlette", starlette_mod)
    return fake


@pytest.mark.unit
class TestSentryIsWiredIntoLifespan:
    """Tier-1 structural: 呼び出し元がテストのみ、という状態が解消されている。"""

    def test_main_imports_init_sentry(self) -> None:
        assert main_mod.init_sentry is sentry_mod.init_sentry

    def test_lifespan_source_calls_init_sentry(self) -> None:
        source = inspect.getsource(main_mod.lifespan)
        assert "init_sentry()" in source

    def test_app_lifespan_context_is_configured(self) -> None:
        # FastAPI は router 側の lifespan と merge するため同一関数にはならない。
        # 実際に uvicorn が回す context が存在することだけを構造的に確認し、
        # 「本当に init されるか」は下の TestLifespanInitializesSentry が
        # app.router.lifespan_context を実走して検証する。
        assert main_mod.app.router.lifespan_context is not None


@pytest.mark.unit
@pytest.mark.asyncio
class TestLifespanInitializesSentry:
    async def test_initializes_once_when_dsn_set(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """EVENT-DRIVEN: DSN 設定済で起動すると Sentry が 1 度だけ初期化される。"""
        fake = _install_fake_sentry_sdk(monkeypatch)
        monkeypatch.setenv("SENTRY_DSN", "https://pub@o1.ingest.de.sentry.io/1")

        assert is_sentry_initialized() is False
        async with main_mod.app.router.lifespan_context(main_mod.app):
            assert is_sentry_initialized() is True

        assert len(fake.init_calls) == 1
        assert fake.init_calls[0]["dsn"] == "https://pub@o1.ingest.de.sentry.io/1"

    async def test_idempotent_across_two_startups(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """UNWANTED: 同一プロセスで 2 回起動しても二重 init しない。"""
        fake = _install_fake_sentry_sdk(monkeypatch)
        monkeypatch.setenv("SENTRY_DSN", "https://pub@o1.ingest.de.sentry.io/1")

        async with main_mod.app.router.lifespan_context(main_mod.app):
            pass
        async with main_mod.app.router.lifespan_context(main_mod.app):
            pass

        assert len(fake.init_calls) == 1
        assert is_sentry_initialized() is True

    async def test_starts_normally_without_dsn(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """UNWANTED: DSN 未設定でも起動は継続し、ルートは通常応答する。"""
        monkeypatch.delenv("SENTRY_DSN", raising=False)

        async with main_mod.app.router.lifespan_context(main_mod.app):
            transport = ASGITransport(app=main_mod.app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                response = await client.get("/health")

        assert response.status_code == 200
        assert is_sentry_initialized() is False

    async def test_skip_is_logged_when_dsn_missing(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """UNWANTED: 未設定時は例外ではなく skip ログで通知する。"""
        monkeypatch.delenv("SENTRY_DSN", raising=False)

        with caplog.at_level("WARNING"):
            async with main_mod.app.router.lifespan_context(main_mod.app):
                pass

        assert any("Sentry initialization skipped" in r.message for r in caplog.records)

    async def test_startup_survives_unexpected_init_failure(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """UNWANTED: 観測基盤の想定外エラーを起動障害へ昇格させない。"""

        def _boom() -> bool:
            raise RuntimeError("sentry exploded")

        monkeypatch.setattr(main_mod, "init_sentry", _boom)

        with caplog.at_level("WARNING"):
            async with main_mod.app.router.lifespan_context(main_mod.app):
                pass

        assert any("sentry initialization failed" in r.message for r in caplog.records)
