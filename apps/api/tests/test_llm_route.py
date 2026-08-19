"""GAP-178: 実行経路の決定を 1 か所に閉じ、env の「不在」に依存させない。

経営者指摘:「env 消さないと使われる設計もおかしいですよね？？」

その通りで、以下を構造で保証する:
  1. 未設定は「本人サブスク」— 消し忘れではなく明示された既定
  2. 打ち間違い・未知の値でも**黙って別の支払者にならない** (安全側へ倒して警告)
  3. `api` を明示しても、課金許可が無ければ運営に課金しない
  4. 運営が肩代わりする設定は**必ず警告として可視化**される
  5. API 経路は削除していない — 明示スイッチで即使える
"""

from __future__ import annotations

from src.services.chat_sse.llm_route import describe_llm_route, resolve_llm_route


def test_unset_means_user_subscription() -> None:
    r = resolve_llm_route({})
    assert r.route == "relay"
    assert r.is_user_subscription is True
    assert r.warnings == []


def test_typo_falls_back_to_user_subscription_with_warning() -> None:
    """打ち間違いが黙って支払者を変えない (安全側 + 警告)。"""
    r = resolve_llm_route({"ATELIER_LLM_PROVIDER": "rely"})
    assert r.route == "relay"
    assert r.is_user_subscription is True
    assert any("未知の値" in w for w in r.warnings)


def test_api_requested_without_permission_does_not_bill_owner() -> None:
    """`=api` を明示しても課金許可が無ければ運営に課金しない。"""
    r = resolve_llm_route({"ATELIER_LLM_PROVIDER": "api", "ANTHROPIC_API_KEY": "sk-ant-x"})
    assert r.route == "relay"
    assert r.is_user_subscription is True
    assert any("API 課金は行いません" in w for w in r.warnings)


def test_api_is_not_deleted_and_works_when_explicitly_enabled() -> None:
    """**API 経路は残してある** — 明示スイッチ 2 つで即使える。"""
    r = resolve_llm_route(
        {
            "ATELIER_LLM_PROVIDER": "api",
            "ATELIER_ALLOW_API_BILLING": "1",
            "ANTHROPIC_API_KEY": "sk-ant-x",
        }
    )
    assert r.route == "api"
    assert r.is_user_subscription is False
    assert "運営" in r.payer


def test_key_present_but_unused_is_stated_explicitly() -> None:
    """キーがあるのに使わないことを黙らない (誤解を生まない)。"""
    r = resolve_llm_route({"ANTHROPIC_API_KEY": "sk-ant-x"})
    assert r.route == "relay"
    assert any("使いません" in w for w in r.warnings)


def test_owner_paid_fallback_is_always_surfaced() -> None:
    """Bridge 未接続時の肩代わり (運営負担) は必ず警告として見える。"""
    r = resolve_llm_route({"ATELIER_ALLOW_API_BILLING": "1", "ANTHROPIC_API_KEY": "sk-ant-x"})
    assert r.route == "relay"
    assert r.api_fallback_allowed is True
    # 主経路は本人サブスクでも「運営に費用が発生しうる」ので健全とは言わない
    assert r.is_user_subscription is False
    assert any("肩代わり" in w for w in r.warnings)
    assert "肩代わり" in describe_llm_route(
        {"ATELIER_ALLOW_API_BILLING": "1", "ANTHROPIC_API_KEY": "sk-ant-x"}
    )


def test_agent_sdk_stays_available_for_self_host() -> None:
    r = resolve_llm_route({"ATELIER_LLM_PROVIDER": "agent_sdk"})
    assert r.route == "agent_sdk"
    assert any("セルフホスト" in w for w in r.warnings)


def test_describe_is_one_readable_line() -> None:
    line = describe_llm_route({})
    assert line.startswith("AI 実行経路: relay")
    assert "利用者本人の Claude サブスク" in line
