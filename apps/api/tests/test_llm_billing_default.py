"""GAP-175: 「既定で運営の API キーに落ちない」ことを構造で固定する。

経営者の確認:「API キーで LLM は動かさない状態にしているよね？ 全てサブスク
プランだよね？」— 実際には `ATELIER_LLM_PROVIDER=relay` を**明示したときだけ**
サブスク経路で、未設定だと `ANTHROPIC_API_KEY` (運営の従量課金) に落ちていた。
確定アーキテクチャと正反対だったので既定を反転させた。ここはその回帰テスト。
"""

from __future__ import annotations

import pytest

from src.services.chat_sse.llm_chain import LLMUnavailable, api_billing_allowed, llm_complete
from src.services.chat_sse.relay import relay_mode_enabled


def _clear(monkeypatch: pytest.MonkeyPatch) -> None:
    for k in ("ATELIER_LLM_PROVIDER", "ATELIER_ALLOW_FAKE_LLM", "ATELIER_ALLOW_API_BILLING"):
        monkeypatch.delenv(k, raising=False)


def test_relay_is_the_default_route(monkeypatch: pytest.MonkeyPatch) -> None:
    """ATELIER_LLM_PROVIDER 未設定 = 本人の PC の Bridge (本人サブスク)。"""
    _clear(monkeypatch)
    assert relay_mode_enabled() is True


def test_other_providers_stay_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear(monkeypatch)
    monkeypatch.setenv("ATELIER_LLM_PROVIDER", "agent_sdk")
    assert relay_mode_enabled() is False
    monkeypatch.setenv("ATELIER_LLM_PROVIDER", "relay")
    assert relay_mode_enabled() is True


def test_api_billing_is_denied_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """運営の API 課金は明示 opt-in が無い限り禁止。"""
    _clear(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-not-be-used")
    assert api_billing_allowed() is False
    monkeypatch.setenv("ATELIER_ALLOW_API_BILLING", "1")
    assert api_billing_allowed() is True


@pytest.mark.asyncio
async def test_key_present_but_bridge_offline_refuses_instead_of_billing_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """**本丸**: 運営のキーが環境にあっても、Bridge 未接続なら課金せず断る。

    以前はここで黙って ANTHROPIC_API_KEY を使い、Bridge が繋がっていない
    全ユーザー分の LLM 費用が運営持ちになる状態だった。
    """
    _clear(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-not-be-used")

    # relay は presence を見に行くので、オフライン相当にスタブする
    from src.services.chat_sse import relay as relay_mod

    async def _offline(*_a: object, **_k: object):  # pragma: no cover - 直後に raise
        raise relay_mod.RelayUnavailable
        yield ""  # 型のため (async generator)

    monkeypatch.setattr(relay_mod, "relay_stream_chunks", _offline)

    called = False

    def _fake() -> str:
        nonlocal called
        called = True
        return "fake output"

    with pytest.raises(LLMUnavailable) as exc:
        await llm_complete(system_prompt="s", user_text="u", actor_id="u1", fake=_fake)
    assert exc.value.code == "bridge_offline"
    # fake も API も使われない (ATELIER_ALLOW_FAKE_LLM 未設定のため)
    assert called is False
