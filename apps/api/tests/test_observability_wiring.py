"""T-F-42: Sentry が API の**実行経路**から初期化されることの検証。

T-F-08 は `init_sentry()` を実装したが呼び出し元がテストだけで、本番 API は
Sentry 未初期化のままだった (GAP-108)。ここでは「定義がある」ではなく
「lifespan から実際に呼ばれ、初期化状態になる」ことを検証する。

**fake SDK を `sys.modules` に注入した証明は本タスクの充足として認めない**
(tickets.json T-F-42 tier_2 UNWANTED)。初回実装ではそれをやってしまい、
`sentry-sdk` 未導入で `init_sentry()` が ImportError 分岐に落ち実送信 0 件、
という本体症状が残っていた (qa 実測で発覚)。
本ファイルは **実 `sentry_sdk` を import した状態**で
`is_sentry_initialized()` と `sentry_sdk.get_client().is_active()` が True に
なることを検証する。
"""

# pyright: reportPrivateUsage=false, reportUnusedFunction=false
from __future__ import annotations

import inspect
from collections.abc import Iterator
from typing import Any

import pytest
import sentry_sdk
from httpx import ASGITransport, AsyncClient

import main as main_mod
import src.observability.sentry as sentry_mod
from src.observability import is_sentry_initialized

TEST_DSN = "https://public@o0.ingest.de.sentry.io/1"
"""実 SDK が受け付ける形式の DSN。イベントを起こさないので送信は発生しない。"""


@pytest.fixture(autouse=True)
def _reset_sentry_state() -> Iterator[None]:
    """idempotent guard をリセットし、テスト後は実クライアントを無効化する。

    実 SDK を初期化したまま次のテストへ持ち越すと、以降の ASGI リクエストが
    全て Sentry 計測を通ってしまうため、global scope の client を外して畳む。
    (`init(dsn=None)` では `_Client` が残り `is_active()` が True のままになる)
    """
    sentry_mod._initialized = False
    sentry_sdk.get_global_scope().set_client(None)
    yield
    sentry_mod._initialized = False
    sentry_sdk.get_global_scope().set_client(None)


@pytest.mark.unit
class TestSentrySdkIsActuallyInstalled:
    """Tier 1: SDK が依存として実在する (配線先が無いまま『配線済み』にしない)。"""

    def test_sentry_sdk_is_importable_without_stubbing(self) -> None:
        assert sentry_sdk.VERSION
        # sys.modules に注入した偽物ではなく、実パッケージであること
        assert "site-packages" in (sentry_sdk.__file__ or "")

    def test_fastapi_integration_is_available(self) -> None:
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration

        assert FastApiIntegration is not None
        assert StarletteIntegration is not None

    def test_declared_as_a_project_dependency(self) -> None:
        """lock だけでなく pyproject.toml の宣言にも入っていること。"""
        from pathlib import Path

        pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
        assert "sentry-sdk[fastapi]" in pyproject.read_text(encoding="utf-8")


@pytest.mark.unit
class TestSentryIsWiredIntoLifespan:
    """Tier 1: 呼び出し元がテストのみ、という状態が解消されている。"""

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
    async def test_real_sdk_initializes_on_startup(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """EVENT-DRIVEN: **実 SDK** で DSN 設定時に初期化される (fake 注入なし)。"""
        monkeypatch.setenv("SENTRY_DSN", TEST_DSN)

        assert is_sentry_initialized() is False
        assert sentry_sdk.get_client().is_active() is False

        async with main_mod.app.router.lifespan_context(main_mod.app):
            assert is_sentry_initialized() is True
            # 実クライアントが本当に立ち上がっている (ImportError 分岐に落ちていない)
            client = sentry_sdk.get_client()
            assert client.is_active() is True
            assert client.dsn == TEST_DSN

    async def test_initializes_exactly_once(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """`sentry_sdk.init` の呼び出しは 1 回だけ。

        実モジュールの属性を spy で包む (実 init へ委譲する)。
        モジュールごと差し替える fake ではない。
        """
        calls: list[dict[str, Any]] = []
        real_init = sentry_sdk.init

        def counting_init(**kwargs: Any) -> Any:
            calls.append(kwargs)
            return real_init(**kwargs)

        monkeypatch.setattr(sentry_sdk, "init", counting_init)
        monkeypatch.setenv("SENTRY_DSN", TEST_DSN)

        async with main_mod.app.router.lifespan_context(main_mod.app):
            pass

        assert len(calls) == 1
        assert calls[0]["dsn"] == TEST_DSN
        # before_send に秘匿ヘッダのスクラバが渡っていること
        assert calls[0]["before_send"] is sentry_mod._scrub_sensitive_fields

    async def test_idempotent_across_two_startups(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """UNWANTED: 同一プロセスで 2 回起動しても二重 init しない。"""
        calls: list[dict[str, Any]] = []
        real_init = sentry_sdk.init

        def counting_init(**kwargs: Any) -> Any:
            calls.append(kwargs)
            return real_init(**kwargs)

        monkeypatch.setattr(sentry_sdk, "init", counting_init)
        monkeypatch.setenv("SENTRY_DSN", TEST_DSN)

        async with main_mod.app.router.lifespan_context(main_mod.app):
            pass
        async with main_mod.app.router.lifespan_context(main_mod.app):
            pass

        assert len(calls) == 1
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
        assert sentry_sdk.get_client().is_active() is False

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
