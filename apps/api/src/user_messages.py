"""失敗の「コード」を、利用者に見せる日本語に翻訳する (GAP-216)。

なぜ要るか
----------
service 層の例外は `code` (機械が分岐する識別子) と `message` (英語) を持つ。
route はこれまで **`message` をそのまま HTTP の detail に入れて**おり、画面は
それを赤帯に描画していた。結果、日本語の製品でサインインに失敗すると
`invalid email or password` と英語で出ていた。同じことが退会・復活・招待・
クライアント入口でも起きていた (29 箇所)。

`message` は**ログと監査のための言葉**で、利用者に見せる言葉ではない。
`code` から日本語を引いて detail に入れる。service 層は一切変えない
(既存のテスト・監査ログはそのまま動く)。

表に無いコードは、利用者にとって「サーバー側の想定外」と同じなので
GAP-215 の定型文に倒す。**英語の内部メッセージが漏れる経路をゼロにする**のが
この関数の役目で、翻訳の網羅はそのための手段。
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from src.errors import UNHANDLED_MESSAGE


@runtime_checkable
class HasCode(Protocol):
    """service 層の例外が共通して持つ形 (code と、あれば subject)。"""

    code: str


#: code → 利用者に見せる日本語。
#:
#: 書き方の原則: **何が起きたか**ではなく **利用者が次に何をすればよいか**まで書く。
#: 「無効なトークンです」では、読んだ人は次の手が分からない。
USER_MESSAGES: dict[str, str] = {
    # ---- 登録 ----------------------------------------------------------- #
    # どちらの同意が足りないかは subject で分岐する (下の LEGAL_DOC_NAMES)。
    # 分からないときだけこの汎用文になる。
    "consent_missing": "利用規約とプライバシーポリシーへの同意が必要です。",
    "email_taken": "このメールアドレスは既に登録されています。サインインをお試しください。",
    # ---- サインイン ------------------------------------------------------ #
    # 存在するアカウントかどうかを漏らさないため、
    # 「見つからない」と「パスワード違い」で文言を変えない。
    "invalid_credentials": "メールアドレスまたはパスワードが違います。",
    "locked": (
        "サインインの失敗が続いたため、一時的に受け付けを止めています。"
        "しばらく時間をおいてからお試しください。"
    ),
    "email_unverified": (
        "メールアドレスの確認が済んでいません。届いている確認メールをご確認ください。"
    ),
    # ---- セッション ------------------------------------------------------ #
    "invalid_refresh": "サインインの有効期限が切れています。もう一度サインインしてください。",
    "invalid_token": "リンクが正しくないか、有効期限が切れています。",
    # ---- 外部サインイン (OAuth) ------------------------------------------ #
    "unknown_provider": "指定されたサインイン方法は利用できません。",
    "provider_disabled": "このサインイン方法は現在利用できません。",
    "exchange_failed": "外部サービスでのサインインに失敗しました。もう一度お試しください。",
    "account_inactive": "このアカウントは現在ご利用いただけません。",
    # ---- 退会・復活 ------------------------------------------------------ #
    "not_found_or_already_deleted": "対象のアカウントが見つからないか、すでに退会済みです。",
    "no_pending_deletion": "退会の申請が見つかりません。",
    "window_expired": "復活を受け付けられる期間を過ぎています。",
    # ---- クライアント入口 (招待 → ポータル) ------------------------------ #
    "expired": ("招待リンクの有効期限が切れています。招待した担当者に再発行をご依頼ください。"),
    "invalid_client_token": (
        "サインインの情報が正しくないか、有効期限が切れています。"
        "招待リンクからもう一度お試しください。"
    ),
    "consent_required": "内容をご確認のうえ、同意にチェックを入れてください。",
    "cross_project": "この内容を表示する権限がありません。",
    "forbidden_scope": "この操作を行う権限がありません。",
    "project_not_found": "対象が見つかりません。",
    "target_not_found": "対象が見つかりません。",
}


#: 法務文書の内部名 → 利用者が画面で見ている名前。
#:
#: 「terms_of_service への同意が必要です」と内部名のまま出さないため。
#: 足りない同意がどれかは利用者にとって必要な情報なので、**日本語にして残す**。
LEGAL_DOC_NAMES: dict[str, str] = {
    "terms_of_service": "利用規約",
    "privacy_policy": "プライバシーポリシー",
    "data_residency": "データの保管場所に関する説明",
    "ai_training_optin": "AI 学習への利用",
}


def user_detail(exc: HasCode) -> str:
    """例外から、利用者に見せる文言を作る。

    **英語の内部メッセージを返す分岐はここに作らない。** 表に足し忘れたコードが
    あっても、漏れるのではなく「サーバー側で問題が発生しました」になる。
    原因の特定はサーバーログと error_log が担う。
    """
    code = exc.code
    subject = getattr(exc, "subject", None)
    if code == "consent_missing" and subject:
        name = LEGAL_DOC_NAMES.get(subject)
        if name:
            return f"{name}への同意が必要です。"
    return USER_MESSAGES.get(code, UNHANDLED_MESSAGE)
