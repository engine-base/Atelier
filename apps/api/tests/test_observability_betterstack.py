"""T-F-39: Better Stack handler が **API のログ設定から実 attach される**ことの検証。

旧 AC は「importable であること」しか要求しておらず、attach されない handler でも
満たせてしまった。ここでは
- `apps/api/main.py` の lifespan が `attach_betterstack_handler()` を実行する
- attach 後にログを 1 本出すと構造化 JSON が送出される
- トークン未設定 / 送信失敗でも例外を出さずローカル出力は残る
- 秘匿値は送出ペイロードでマスクされる
を検証する。
"""

# pyright: reportUnusedFunction=false
from __future__ import annotations

import inspect
import logging
from typing import Any, cast

import pytest

import main as main_mod
from src.observability import (
    BetterStackConfig,
    BetterStackHandler,
    attach_betterstack_handler,
    detach_betterstack_handler,
    is_betterstack_attached,
)
from src.observability.betterstack import (
    DEFAULT_INGEST_HOST,
    REDACTED,
    build_log_payload,
    redact_mapping,
    redact_text,
)

_ENV = ("BETTERSTACK_SOURCE_TOKEN", "BETTERSTACK_INGEST_HOST")


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch: pytest.MonkeyPatch) -> Any:
    """env をクリアし、テスト後に attach 済み handler を必ず外す。"""
    for name in _ENV:
        monkeypatch.delenv(name, raising=False)
    yield
    detach_betterstack_handler()


def _record(message: str, **extra: object) -> logging.LogRecord:
    record = logging.LogRecord(
        name="test.logger",
        level=logging.ERROR,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=None,
        exc_info=None,
    )
    for key, value in extra.items():
        setattr(record, key, value)
    return record


class _CapturingHandler(BetterStackHandler):
    """送出ペイロードを記録するだけの handler。"""

    def __init__(self) -> None:
        super().__init__(BetterStackConfig(source_token="tok"))
        self.shipped: list[dict[str, Any]] = []

    def ship(self, payload: dict[str, Any]) -> bool:
        self.shipped.append(payload)
        return True


@pytest.mark.unit
class TestRedaction:
    @pytest.mark.parametrize(
        "raw",
        [
            "api_key=sk-abcdefghijklmnop",
            "token: abcdefghijklmnop",
            "password=hunter2",
            "Authorization: Bearer abc.def.ghi",
        ],
    )
    def test_key_value_forms_are_redacted(self, raw: str) -> None:
        out = redact_text(raw)
        assert REDACTED in out
        assert "hunter2" not in out
        assert "abcdefghijklmnop" not in out

    def test_bare_provider_keys_are_redacted(self) -> None:
        assert "sk-liveKeyMaterial123" not in redact_text("used sk-liveKeyMaterial123 here")
        assert "sk_live_ABCdef123456789" not in redact_text("charge with sk_live_ABCdef123456789")

    def test_plain_message_is_untouched(self) -> None:
        assert redact_text("workspace created") == "workspace created"

    def test_sensitive_keys_in_mapping(self) -> None:
        out = redact_mapping(
            {
                "ANTHROPIC_API_KEY": "sk-realkeymaterial",
                "user_id": "u1",
                "nested": {"authorization": "Bearer xyz", "ok": 1},
            },
        )
        assert out["ANTHROPIC_API_KEY"] == REDACTED
        assert out["user_id"] == "u1"
        assert out["nested"]["authorization"] == REDACTED
        assert out["nested"]["ok"] == 1


@pytest.mark.unit
class TestPayload:
    def test_structured_fields(self) -> None:
        payload = build_log_payload(_record("workspace created"))
        assert payload["level"] == "ERROR"
        assert payload["message"] == "workspace created"
        assert payload["logger"] == "test.logger"
        assert payload["service"] == "atelier-api"
        assert isinstance(payload["dt"], str)

    def test_extra_is_included_and_redacted(self) -> None:
        payload = build_log_payload(_record("op done", user_id="u1", api_key="sk-secretvalue123"))
        assert payload["extra"]["user_id"] == "u1"
        assert payload["extra"]["api_key"] == REDACTED


@pytest.mark.unit
class TestHandlerEmit:
    def test_emits_structured_json_when_configured(self) -> None:
        handler = _CapturingHandler()
        handler.emit(_record("hello"))
        assert len(handler.shipped) == 1
        assert handler.shipped[0]["message"] == "hello"

    def test_secrets_are_masked_in_shipped_payload(self) -> None:
        """UNWANTED critical: 秘匿値を含むレコードは送出前にマスクされる。"""
        handler = _CapturingHandler()
        handler.emit(_record("calling provider with api_key=sk-supersecretvalue"))
        shipped = handler.shipped[0]
        assert "sk-supersecretvalue" not in str(shipped)
        assert REDACTED in shipped["message"]

    def test_emit_is_noop_without_token(self) -> None:
        """UNWANTED critical: トークン未設定でも例外を出さない。"""
        handler = BetterStackHandler(BetterStackConfig())
        assert handler.enabled is False
        handler.emit(_record("hello"))  # 例外が出なければ PASS

    def test_emit_swallows_shipping_failure(self) -> None:
        """UNWANTED critical: 送信失敗でも例外を送出しない。"""

        class _Exploding(BetterStackHandler):
            def __init__(self) -> None:
                super().__init__(BetterStackConfig(source_token="tok"))
                self.handled = 0

            def ship(self, payload: dict[str, Any]) -> bool:
                raise RuntimeError("network down")

            def handleError(self, record: logging.LogRecord) -> None:
                self.handled += 1

        handler = _Exploding()
        handler.emit(_record("hello"))
        assert handler.handled == 1

    def test_ship_returns_false_on_transport_error(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import httpx

        def _boom(*_args: object, **_kwargs: object) -> httpx.Response:
            raise httpx.ConnectTimeout("timeout")

        monkeypatch.setattr(httpx, "post", _boom)
        handler = BetterStackHandler(BetterStackConfig(source_token="tok"))
        assert handler.ship({"message": "x"}) is False

    def test_ship_posts_to_ingest_host_with_bearer_token(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import httpx

        captured: dict[str, Any] = {}

        def _post(url: str, **kwargs: Any) -> httpx.Response:
            captured["url"] = url
            captured["headers"] = kwargs.get("headers")
            captured["json"] = kwargs.get("json")
            return httpx.Response(202, request=httpx.Request("POST", url))

        monkeypatch.setattr(httpx, "post", _post)
        handler = BetterStackHandler(BetterStackConfig(source_token="tok"))

        assert handler.ship({"message": "x"}) is True
        assert captured["url"] == DEFAULT_INGEST_HOST
        assert captured["headers"]["Authorization"] == "Bearer tok"

    def test_ship_returns_false_on_error_status(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import httpx

        def _post(url: str, **_kwargs: Any) -> httpx.Response:
            return httpx.Response(403, request=httpx.Request("POST", url))

        monkeypatch.setattr(httpx, "post", _post)
        handler = BetterStackHandler(BetterStackConfig(source_token="tok"))
        assert handler.ship({"message": "x"}) is False


@pytest.mark.unit
class TestAttach:
    def test_attach_is_skipped_without_token(self, caplog: pytest.LogCaptureFixture) -> None:
        """UNWANTED critical: トークン未設定なら attach せずローカルログのまま。"""
        with caplog.at_level("WARNING"):
            attached = attach_betterstack_handler()
        assert attached is False
        assert is_betterstack_attached() is False
        assert any("BETTERSTACK_SOURCE_TOKEN" in r.message for r in caplog.records)

    def test_attach_adds_handler_to_root(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("BETTERSTACK_SOURCE_TOKEN", "tok")
        before = len(logging.getLogger().handlers)

        assert attach_betterstack_handler() is True
        assert is_betterstack_attached() is True
        assert len(logging.getLogger().handlers) == before + 1

        detach_betterstack_handler()
        assert is_betterstack_attached() is False
        assert len(logging.getLogger().handlers) == before

    def test_attach_is_idempotent(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("BETTERSTACK_SOURCE_TOKEN", "tok")
        assert attach_betterstack_handler() is True
        assert attach_betterstack_handler() is False

    def test_attached_handler_receives_emitted_records(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """EVENT-DRIVEN: attach 後にログを 1 本出すと構造化 JSON が送出される。"""
        import httpx

        shipped: list[dict[str, Any]] = []

        def _post(url: str, **kwargs: Any) -> httpx.Response:
            payload = kwargs.get("json")
            assert isinstance(payload, dict)
            shipped.append(cast("dict[str, Any]", payload))
            return httpx.Response(202, request=httpx.Request("POST", url))

        monkeypatch.setattr(httpx, "post", _post)
        monkeypatch.setenv("BETTERSTACK_SOURCE_TOKEN", "tok")

        assert attach_betterstack_handler() is True
        target = logging.getLogger("atelier.test.attach")
        target.error("shipped via handler with token=sk-secretmaterial1")
        # QueueListener は背景スレッド。stop() が残りを flush する。
        detach_betterstack_handler()

        assert len(shipped) == 1
        assert "sk-secretmaterial1" not in str(shipped[0])
        assert REDACTED in shipped[0]["message"]


@pytest.mark.unit
class TestWiredIntoApiStartup:
    """Tier 1: API のログ設定が実際に attach する。"""

    def test_main_imports_attach(self) -> None:
        assert main_mod.attach_betterstack_handler is attach_betterstack_handler

    def test_lifespan_source_attaches_and_detaches(self) -> None:
        source = inspect.getsource(main_mod.lifespan)
        assert "attach_betterstack_handler()" in source
        assert "detach_betterstack_handler()" in source


@pytest.mark.unit
@pytest.mark.asyncio
class TestLifespanAttaches:
    async def test_lifespan_attaches_when_token_set(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("BETTERSTACK_SOURCE_TOKEN", "tok")

        async with main_mod.app.router.lifespan_context(main_mod.app):
            assert is_betterstack_attached() is True
        # shutdown で背景スレッドを畳む
        assert is_betterstack_attached() is False

    async def test_lifespan_starts_without_token(self) -> None:
        async with main_mod.app.router.lifespan_context(main_mod.app):
            assert is_betterstack_attached() is False
