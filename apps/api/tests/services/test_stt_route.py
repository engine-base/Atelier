"""GAP-181: 文字起こし経路の決定を固定する unit tests。

要点:
  1. 既定は OSS ローカル (faster-whisper) — 費用ゼロ・音声を外部に出さない
  2. OpenAI Whisper API は **キーがあるだけでは使わない** (明示 opt-in が要る)
  3. どちらも不可なら「できない」と言う (偽の成功を作らない)
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.services.meetings import stt


class TestDefaultIsLocalOss:
    def test_no_env_uses_local_and_costs_nothing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(stt, "faster_whisper_available", lambda: True)
        route = stt.resolve_stt_route({})
        assert route.provider == "local"
        assert route.state == "ready"
        assert route.model == stt.DEFAULT_LOCAL_MODEL
        assert "費用なし" in route.payer
        assert "外部に出ません" in route.payer

    def test_model_is_configurable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(stt, "faster_whisper_available", lambda: True)
        route = stt.resolve_stt_route({"ATELIER_LOCAL_WHISPER_MODEL": "medium"})
        assert route.model == "medium"


class TestApiIsOptInOnly:
    def test_key_alone_does_not_send_audio_to_openai(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(stt, "faster_whisper_available", lambda: True)
        route = stt.resolve_stt_route({stt.OPENAI_KEY_ENV: "sk-secret"})
        assert route.provider == "local"
        assert stt.whisper_api_allowed({stt.OPENAI_KEY_ENV: "sk-secret"}) is False
        assert any("明示 opt-in" in w for w in route.warnings)

    def test_provider_request_without_opt_in_falls_back_with_warning(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(stt, "faster_whisper_available", lambda: True)
        route = stt.resolve_stt_route({stt.PROVIDER_ENV: "openai", stt.OPENAI_KEY_ENV: "sk-secret"})
        assert route.provider == "local"
        assert any(stt.ALLOW_API_ENV in w for w in route.warnings)

    def test_explicit_opt_in_uses_api_and_says_who_pays(self) -> None:
        """API 経路は削除していない (将来また使えるようにしてある)。"""
        route = stt.resolve_stt_route(
            {
                stt.PROVIDER_ENV: "openai",
                stt.ALLOW_API_ENV: "1",
                stt.OPENAI_KEY_ENV: "sk-secret",
            }
        )
        assert route.provider == "openai"
        assert route.state == "ready"
        assert "運営負担" in route.payer
        assert "OpenAI へ送信" in route.payer


class TestUnavailableIsHonest:
    def test_missing_component_explains_how_to_install(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(stt, "faster_whisper_available", lambda: False)
        route = stt.resolve_stt_route({})
        assert route.provider == "none"
        assert route.state == "unavailable"
        assert any("uv sync --extra localrag" in step for step in route.next_steps)

    @pytest.mark.asyncio
    async def test_transcribe_raises_instead_of_returning_empty_text(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv(stt.OPENAI_KEY_ENV, raising=False)
        monkeypatch.delenv(stt.ALLOW_API_ENV, raising=False)
        monkeypatch.setattr(stt, "faster_whisper_available", lambda: False)
        with pytest.raises(stt.STTUnavailable) as exc:
            await stt.transcribe(b"x", file_name="a.mp3", mime_type="audio/mpeg")
        assert exc.value.code == "stt_unavailable"


class TestDescribe:
    def test_describe_includes_provider_and_payer(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(stt, "faster_whisper_available", lambda: True)
        line = stt.describe_stt_route({})
        assert "stt route=local" in line
        assert "費用なし" in line
