"""T-F-38: Langfuse が **実 LLM 呼び出し経路から**トレースを発行することの検証。

旧 AC は「importable であること」しか要求しておらず、誰も呼ばない client でも
満たせてしまった (GAP-108 と同じ失敗形)。ここでは
`src.llm.client.select_client()` が返す実クライアントで `complete()` を 1 回叩き、
トレースが 1 件出ることを検証する。

また critical AC として、
- 未設定 → no-op + warning、LLM 応答は正常
- 送信失敗 / タイムアウト → LLM 応答は正常
を明示的に検証する。
"""

# pyright: reportUnusedFunction=false
from __future__ import annotations

from typing import Any, cast

import pytest

from src.llm.client import (
    LLMMessage,
    LLMResponse,
    LLMUsage,
    TracedLLMClient,
    select_client,
)
from src.observability import LangfuseClient, LLMTrace
from src.observability.langfuse import (
    DEFAULT_LANGFUSE_HOST,
    INGESTION_PATH,
    LangfuseConfig,
    build_ingestion_payload,
    get_langfuse_client,
)

_LANGFUSE_ENV = ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST")


@pytest.fixture(autouse=True)
def _clear_langfuse_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """テスト間で env が漏れないように毎回クリアする。"""
    for name in _LANGFUSE_ENV:
        monkeypatch.delenv(name, raising=False)


class _FakeInner:
    """LLMClient Protocol 互換の fake。呼び出し回数を数える。"""

    provider = "anthropic"

    def __init__(self, *, raises: Exception | None = None) -> None:
        self.calls = 0
        self._raises = raises

    async def complete(
        self,
        *,
        model: str,
        messages: list[LLMMessage],
        system: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 1.0,
        stop_sequences: list[str] | None = None,
    ) -> LLMResponse:
        del messages, system, max_tokens, temperature, stop_sequences
        self.calls += 1
        if self._raises is not None:
            raise self._raises
        return LLMResponse(
            text="ok",
            model=model or "claude-sonnet-4-6",
            stop_reason="end_turn",
            usage=LLMUsage(input_tokens=11, output_tokens=7),
            raw=None,
        )


class _RecordingTracer(LangfuseClient):
    """送信内容を記録するだけの LangfuseClient。"""

    def __init__(self) -> None:
        super().__init__(LangfuseConfig(public_key="pk", secret_key="sk"))
        self.traces: list[LLMTrace] = []

    async def trace(self, trace: LLMTrace) -> bool:
        self.traces.append(trace)
        return True


class _ExplodingTracer(LangfuseClient):
    """trace() が例外を投げる壊れた tracer (握り潰し検証用)。"""

    def __init__(self) -> None:
        super().__init__(LangfuseConfig(public_key="pk", secret_key="sk"))

    async def trace(self, trace: LLMTrace) -> bool:
        raise RuntimeError("langfuse exploded")


async def _complete(client: Any) -> LLMResponse:
    return await client.complete(
        model="claude-sonnet-4-6",
        messages=[LLMMessage(role="user", content="hi")],
    )


@pytest.mark.unit
class TestImportContract:
    """Tier 1: src.observability から re-export されている。"""

    def test_reexports_from_package(self) -> None:
        from src.observability import LangfuseClient as ReExported

        assert ReExported is LangfuseClient

    def test_default_client_is_shared(self) -> None:
        assert get_langfuse_client() is get_langfuse_client()


@pytest.mark.unit
class TestConfig:
    def test_resolves_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-env")
        monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-env")
        monkeypatch.setenv("LANGFUSE_HOST", "https://langfuse.internal/")
        cfg = LangfuseConfig()
        assert cfg.resolve_public_key() == "pk-env"
        assert cfg.resolve_secret_key() == "sk-env"
        # 末尾スラッシュは正規化される
        assert cfg.resolve_host() == "https://langfuse.internal"

    def test_defaults_to_cloud_host(self) -> None:
        assert LangfuseConfig().resolve_host() == DEFAULT_LANGFUSE_HOST

    def test_enabled_requires_both_keys(self) -> None:
        assert LangfuseClient(LangfuseConfig(public_key="pk")).enabled is False
        assert LangfuseClient(LangfuseConfig(secret_key="sk")).enabled is False
        assert LangfuseClient(LangfuseConfig(public_key="pk", secret_key="sk")).enabled is True


@pytest.mark.unit
class TestIngestionPayload:
    def test_carries_model_latency_and_usage(self) -> None:
        payload = build_ingestion_payload(
            LLMTrace(
                provider="anthropic",
                model="claude-sonnet-4-6",
                latency_ms=123.456,
                input_tokens=11,
                output_tokens=7,
            ),
        )
        batch = payload["batch"]
        generation = next(e for e in batch if e["type"] == "generation-create")
        body = generation["body"]
        assert body["model"] == "claude-sonnet-4-6"
        metadata = cast("dict[str, object]", body["metadata"])
        assert metadata["latency_ms"] == 123.456
        assert body["usage"] == {"input": 11, "output": 7, "total": 18, "unit": "TOKENS"}
        # trace-create と generation-create が同じ traceId で結ばれている
        trace_event = next(e for e in batch if e["type"] == "trace-create")
        assert body["traceId"] == trace_event["body"]["id"]

    def test_does_not_carry_prompt_or_completion(self) -> None:
        """AI 学習デフォルト OFF: 顧客データを外部トレース基盤へ送らない。"""
        payload = build_ingestion_payload(
            LLMTrace(
                provider="anthropic",
                model="claude-sonnet-4-6",
                latency_ms=1.0,
                input_tokens=1,
                output_tokens=1,
            ),
        )
        batch = payload["batch"]
        for event in batch:
            # body 直下に prompt / completion 本文のキーが無いこと
            # (usage の input/output は件数であって本文ではない)
            assert "input" not in event["body"]
            assert "output" not in event["body"]


@pytest.mark.unit
@pytest.mark.asyncio
class TestRealLLMPathEmitsTrace:
    async def test_select_client_returns_traced_wrapper(self) -> None:
        """Tier 1: 実 LLM 経路が LangfuseClient を通る (定義だけにしない)。"""
        client = select_client("openai")
        assert isinstance(client, TracedLLMClient)
        assert client.provider == "openai"

    async def test_one_call_emits_exactly_one_trace(self) -> None:
        """EVENT-DRIVEN: 1 回の LLM 呼び出しで model/latency/usage を含むトレース 1 件。"""
        tracer = _RecordingTracer()
        inner = _FakeInner()
        client = TracedLLMClient(inner, tracer=tracer)

        response = await _complete(client)

        assert response.text == "ok"
        assert inner.calls == 1
        assert len(tracer.traces) == 1
        trace = tracer.traces[0]
        assert trace.provider == "anthropic"
        assert trace.model == "claude-sonnet-4-6"
        assert trace.input_tokens == 11
        assert trace.output_tokens == 7
        assert trace.latency_ms >= 0.0

    async def test_llm_error_is_not_swallowed(self) -> None:
        """トレース配線が本来の例外を隠さないこと (握り潰すのは送信失敗だけ)。"""
        tracer = _RecordingTracer()
        client = TracedLLMClient(_FakeInner(raises=ValueError("upstream")), tracer=tracer)

        with pytest.raises(ValueError, match="upstream"):
            await _complete(client)
        assert tracer.traces == []


@pytest.mark.unit
@pytest.mark.asyncio
class TestFailuresDoNotBreakLLMCalls:
    async def test_unconfigured_is_noop_with_warning(
        self,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """UNWANTED: 鍵未設定でも LLM 呼び出しは成功する。"""
        client = TracedLLMClient(_FakeInner(), tracer=LangfuseClient(LangfuseConfig()))

        with caplog.at_level("WARNING"):
            response = await _complete(client)

        assert response.text == "ok"
        assert any("LANGFUSE_PUBLIC_KEY" in r.message for r in caplog.records)

    async def test_tracer_exception_does_not_break_the_call(
        self,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """UNWANTED: tracer が例外を投げても LLM 応答は正常。"""
        client = TracedLLMClient(_FakeInner(), tracer=_ExplodingTracer())

        with caplog.at_level("WARNING"):
            response = await _complete(client)

        assert response.text == "ok"
        assert any("langfuse tracing failed" in r.message for r in caplog.records)

    async def test_transport_error_is_swallowed(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """UNWANTED: HTTP 送信がタイムアウトしても trace() は False を返すだけ。"""
        import httpx

        tracer = LangfuseClient(LangfuseConfig(public_key="pk", secret_key="sk"))

        async def _boom(*_args: object, **_kwargs: object) -> httpx.Response:
            raise httpx.ConnectTimeout("timeout")

        monkeypatch.setattr(httpx.AsyncClient, "post", _boom)

        with caplog.at_level("WARNING"):
            shipped = await tracer.trace(
                LLMTrace(
                    provider="anthropic",
                    model="m",
                    latency_ms=1.0,
                    input_tokens=1,
                    output_tokens=1,
                ),
            )

        assert shipped is False
        assert any("langfuse trace shipping failed" in r.message for r in caplog.records)

    async def test_http_error_status_returns_false(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """4xx/5xx は例外にせず False で返す。"""
        import httpx

        captured: dict[str, object] = {}

        async def _post(
            _self: httpx.AsyncClient,
            url: str,
            **kwargs: object,
        ) -> httpx.Response:
            captured["url"] = url
            captured["auth"] = kwargs.get("auth")
            return httpx.Response(401, request=httpx.Request("POST", url))

        monkeypatch.setattr(httpx.AsyncClient, "post", _post)
        tracer = LangfuseClient(LangfuseConfig(public_key="pk", secret_key="sk"))

        shipped = await tracer.trace(
            LLMTrace(
                provider="anthropic",
                model="m",
                latency_ms=1.0,
                input_tokens=1,
                output_tokens=1,
            ),
        )

        assert shipped is False
        assert captured["url"] == f"{DEFAULT_LANGFUSE_HOST}{INGESTION_PATH}"
        assert captured["auth"] == ("pk", "sk")

    async def test_successful_shipping_returns_true(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import httpx

        async def _post(
            _self: httpx.AsyncClient,
            url: str,
            **_kwargs: object,
        ) -> httpx.Response:
            return httpx.Response(207, request=httpx.Request("POST", url))

        monkeypatch.setattr(httpx.AsyncClient, "post", _post)
        tracer = LangfuseClient(LangfuseConfig(public_key="pk", secret_key="sk"))

        assert (
            await tracer.trace(
                LLMTrace(
                    provider="anthropic",
                    model="m",
                    latency_ms=1.0,
                    input_tokens=1,
                    output_tokens=1,
                ),
            )
            is True
        )
