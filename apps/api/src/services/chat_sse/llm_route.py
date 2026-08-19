"""GAP-178: AI 実行経路の唯一の決定箇所 (誰の費用で動くかを 1 か所で決める)。

経営者指摘:
  「env 消さないと使われる設計もおかしいですよね？？」

そのとおりで、GAP-175 の時点では **環境変数の「不在」に正しい挙動が依存**して
いた (`ATELIER_LLM_PROVIDER` が未設定なら本人サブスク)。この形だと:

  - 昔設定した値が残っているだけで、黙って別の経路 (= 別の支払者) になる
  - 打ち間違い (`ATELIER_LLM_PROVIDER=rely` 等) が黙って経路を変える
  - 「今どの経路で動いているか」がサーバーの env を読まないと分からない

を全部踏む。ここでは逆に **「明示されていなければ本人サブスク」「怪しければ
安全側 (本人サブスク) に倒して警告を残す」「結果は必ず可視化できる形で返す」**
の 3 点を、この 1 関数に閉じ込める。

**API 経路は削除していない**。運営の従量課金 (ANTHROPIC_API_KEY) も
顧客の BYOK も配線はそのままで、`ATELIER_ALLOW_API_BILLING=1` の明示スイッチで
即座に使える。既定で黙って課金されないようにしただけ。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

PROVIDER_ENV = "ATELIER_LLM_PROVIDER"
API_BILLING_ENV = "ATELIER_ALLOW_API_BILLING"
FAKE_ENV = "ATELIER_ALLOW_FAKE_LLM"
API_KEY_ENV = "ANTHROPIC_API_KEY"

# 受け付ける値。これ以外は「打ち間違い」とみなして安全側へ倒す。
_RELAY_VALUES = frozenset({"", "relay"})
_SUBSCRIPTION_VALUES = frozenset({"agent_sdk", "claude_subscription", "subscription"})
_API_VALUES = frozenset({"api", "anthropic", "api_key"})

PAYER_LABEL = {
    "relay": "利用者本人の Claude サブスク (本人の PC の Bridge)",
    "agent_sdk": "サーバー所有者の Claude サブスク (セルフホスト個人インスタンス)",
    "api": "運営の Anthropic API 従量課金",
    "fake": "課金なし (テスト用の決定的スタブ)",
}


@dataclass(frozen=True)
class LLMRoute:
    """今この環境で AI 実行に使う経路と、その費用の出どころ。"""

    route: str  # relay / agent_sdk / api / fake
    payer: str
    #: 「なぜこの経路になったか」— 画面・ログにそのまま出せる日本語
    reason: str
    #: 設定の危うさ (打ち間違い・課金未許可の指定 等)。空なら健全。
    warnings: list[str] = field(default_factory=lambda: list[str]())
    #: 主経路が本人サブスクでも、Bridge 未接続時に**運営の API 課金へ回してよいか**。
    #: 既定 False。有効にすると運営に費用が発生するので、画面にも必ず出す。
    api_fallback_allowed: bool = False

    @property
    def is_user_subscription(self) -> bool:
        """利用者本人の費用で動くか (= 運営に LLM 費用が乗らないか)。"""
        return self.route in ("relay", "fake") and not self.api_fallback_allowed


def resolve_llm_route(env: dict[str, str] | None = None) -> LLMRoute:
    """実行経路を決める唯一の関数。env を読むのはここだけにする。"""
    src = os.environ if env is None else env
    raw = (src.get(PROVIDER_ENV) or "").strip().lower()
    billing_ok = (src.get(API_BILLING_ENV) or "").strip() == "1"
    fake_ok = (src.get(FAKE_ENV) or "").strip() == "1"
    has_key = bool((src.get(API_KEY_ENV) or "").strip())
    warnings: list[str] = []

    # テスト専用スタブ。**明示指定 (relay/agent_sdk/api) がある場合は指定が勝つ** —
    # ATELIER_ALLOW_FAKE_LLM は「経路を選んでいないテスト環境に Bridge が無い」
    # ことを補うためのものであって、選んだ経路を上書きするものではない。
    if fake_ok and raw == "":
        return LLMRoute(
            route="fake",
            payer=PAYER_LABEL["fake"],
            reason=f"{FAKE_ENV}=1 のためテスト用スタブで応答します (本番では設定しないこと)",
            warnings=["テスト用スタブが有効です。本番環境なら直ちに解除してください"],
        )

    # 主経路が本人サブスクでも、明示的に許可されていれば Bridge 未接続時の
    # 肩代わり (運営課金) を認める。既定は False。
    api_fallback = billing_ok and has_key

    if raw in _API_VALUES:
        if billing_ok and has_key:
            return LLMRoute(
                route="api",
                payer=PAYER_LABEL["api"],
                reason=f"{PROVIDER_ENV}={raw} かつ {API_BILLING_ENV}=1 のため運営の API 課金で実行します",
                api_fallback_allowed=True,
            )
        # 明示指定でも、課金許可またはキーが無いなら**運営課金にはしない**。
        # 経路を止めるのではなく本人サブスクへ倒す (= 安全側)。
        missing = API_BILLING_ENV if not billing_ok else API_KEY_ENV
        warnings.append(
            f"{PROVIDER_ENV}={raw} が指定されていますが {missing} が無いため "
            "API 課金は行いません。本人サブスク (Bridge) で実行します"
        )
        return LLMRoute(
            route="relay",
            payer=PAYER_LABEL["relay"],
            reason="API 課金が許可されていないため本人サブスクへ切り替えました",
            warnings=warnings,
            api_fallback_allowed=False,
        )

    if raw in _SUBSCRIPTION_VALUES:
        return LLMRoute(
            route="agent_sdk",
            payer=PAYER_LABEL["agent_sdk"],
            reason=f"{PROVIDER_ENV}={raw} のためサーバー内のサブスク実行を使います",
            warnings=[
                "この経路はセルフホスト個人インスタンス専用です "
                "(サブスク認証はパーソナルユース限定)"
            ],
            api_fallback_allowed=api_fallback,
        )

    if raw not in _RELAY_VALUES:
        # 打ち間違い・未知の値。黙って別経路にせず、安全側 (本人サブスク) に倒す。
        warnings.append(
            f"{PROVIDER_ENV}='{raw}' は未知の値です。"
            "本人サブスク (Bridge) として扱いました — 綴りを確認してください"
        )

    reason = (
        "既定 (本人の PC の Bridge = 本人の Claude サブスク) で実行します"
        if raw == ""
        else f"{PROVIDER_ENV}={raw or 'relay'} のため本人サブスクで実行します"
    )
    if has_key and not billing_ok:
        # 「キーはあるが使わない」ことを明示する — 黙って課金しない設計の可視化
        warnings.append(
            f"{API_KEY_ENV} は設定されていますが、{API_BILLING_ENV}=1 が無いので使いません "
            "(運営に LLM 費用は発生しません)"
        )
    if api_fallback:
        warnings.append(
            f"{API_BILLING_ENV}=1 のため、Bridge 未接続時は運営の API 課金へ"
            "肩代わりします (運営に LLM 費用が発生します)"
        )
    return LLMRoute(
        route="relay",
        payer=PAYER_LABEL["relay"],
        reason=reason,
        warnings=warnings,
        api_fallback_allowed=api_fallback,
    )


def describe_llm_route(env: dict[str, str] | None = None) -> str:
    """起動ログ・運営画面に出す 1 行サマリー。"""
    r = resolve_llm_route(env)
    line = f"AI 実行経路: {r.route} / 費用: {r.payer} — {r.reason}"
    if r.api_fallback_allowed and r.route != "api":
        line += " | Bridge 未接続時は運営の API 課金へ肩代わりします"
    if r.warnings:
        line += " | 注意: " + " / ".join(r.warnings)
    return line
