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

#: 運営側の設定不備。利用者にできることは「連絡する」だけなので原因は書かない。
CONFIG_ERROR = "サーバー側の設定に問題があります。運営にお問い合わせください。"

#: 保存先とのやり取りの失敗。時間をおけば直ることがある。
STORAGE_ERROR = "ファイルの保存先とのやり取りに失敗しました。時間をおいて、もう一度お試しください。"


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
    # GAP-227: 招待が取り消されたあとのアクセス。「なぜ入れないのか」と
    # 「誰に言えばいいか」を書く (利用者は自分では直せない)。
    "invitation_revoked": (
        "この招待は取り消されています。引き続きご覧になる場合は、招待した担当者にご連絡ください。"
    ),
    "cross_project": "この内容を表示する権限がありません。",
    "forbidden_scope": "この操作を行う権限がありません。",
    "project_not_found": "対象が見つかりません。",
    "target_not_found": "対象が見つかりません。",
    # ---- 見つからない / 状態が合わない (GAP-225) -------------------------- #
    # 同じ code を多くの service が使う。**どの種類のものが見つからないか**は
    # CLASS_MESSAGES で個別に言う (下)。ここはその既定値。
    "not_found": "対象が見つかりません。",
    "invalid_state": "いまの状態ではこの操作を行えません。画面を再読み込みしてお試しください。",
    "already_decided": "この候補はすでに判断済みです。",
    "already_default": "すでに運営の既定を引き継いでいます。",
    "already_done": "この工程はすでに完了しています。",
    "already_frozen": "この契約内容はすでに確定済みです。",
    "not_frozen": "先に契約内容を確定してください。",
    "not_active": "この工程はすでに確定済みです。",
    "not_pending": "この依頼はすでに処理済みです。",
    "not_skippable": "この工程は飛ばせません。",
    "no_queued": "順番待ちの作業がありません。",
    "no_current_version": "現行の版が見つかりません。運営にお問い合わせください。",
    "no_employee": "この工程を担当できる AI 社員がいません。担当部門の設定をご確認ください。",
    "confirm_required": "確定すると成果物が凍結され、以後の追加は次のフェーズになります。内容をご確認のうえ承認してください。",
    "hard_gate": "この工程は重要な確認が必要です。内容をご確認のうえ承認してください。",
    "bad_stage": "前の工程がまだ終わっていません。",
    "version_mismatch": "表示中の内容が古くなっています。最新の内容を読み直してから、もう一度お試しください。",
    "unsupported_type": "この種類は同意の対象ではありません。",
    "invalid_assignee": "同じワークスペースの AI 社員のみ割り当てられます。",
    "screen_coverage_lt_100": "すべての画面が対応表に載っていないため確定できません。未対応の画面をご確認ください。",
    "analysis_missing": "この議事録には、フェーズ提案の根拠になる内容がありませんでした。",
    "empty": "文字起こしの本文が空です。",
    "index_out_of_range": "指定された添付が見つかりません。",
    "gone": "この共有リンクは期限切れか、無効化されています。",
    "forbidden": "この操作を行う権限がありません。",
    "too_many": "一度に扱える件数の上限に達しています。数を減らすか、いまの処理が終わってからお試しください。",
    "rate_limited": "短い間に操作が集中しています。少し待ってから、もう一度お試しください。",
    "security": "安全性の確認で問題が見つかったため、この内容は取り込めません。",
    # ---- 大きさ・形式 ---------------------------------------------------- #
    "too_large": "内容が上限を超えています。小さく分けてから、もう一度お試しください。",
    "unsupported": "この形式には対応していません。",
    "unsupported_media_type": "この形式のファイルは扱えません。",
    "binary": "この形式のファイルは文章の差分を表示できません。",
    "no_html": "この成果物には、対象になる内容がありません。",
    "no_table": "この成果物には表が無いため、Excel 形式にできません。HTML / PDF をご利用ください。",
    "content_unavailable": "この版の本文を読み込めませんでした。時間をおいて、もう一度お試しください。",
    "conflict": "ほかの操作と同時に行われたため、反映できませんでした。もう一度お試しください。",
    # ---- AI / 外部サービス ------------------------------------------------ #
    # **原因は書かない。** どの API がどう失敗したかは運営がログで見る。
    "llm_failed": "AI の処理に失敗しました。時間をおいて、もう一度お試しください。",
    "parse_failed": "AI の応答を読み取れませんでした。もう一度お試しください。",
    "llm_unconfigured": "AI の設定が済んでいないため実行できません。運営にお問い合わせください。",
    "bridge_offline": "お使いの PC の Bridge がオフラインです。Bridge アプリを起動してから、もう一度お試しください。",
    # ---- 運営側の設定漏れ (利用者は何もできない) -------------------------- #
    "auth_not_configured": CONFIG_ERROR,
    "unconfigured": CONFIG_ERROR,
    "env_unconfigured": CONFIG_ERROR,
    "storage_unconfigured": CONFIG_ERROR,
    "invalid_storage_path": CONFIG_ERROR,
    "storage_sign_failed": STORAGE_ERROR,
    "storage_upload_failed": STORAGE_ERROR,
    "storage_download_failed": STORAGE_ERROR,
    "supabase_admin_error": UNHANDLED_MESSAGE,
    "supabase_auth_error": UNHANDLED_MESSAGE,
    "post_insert_missing": UNHANDLED_MESSAGE,
}

#: 同じ code でも、どの機能で起きたかで言うべきことが変わるもの。
#: `(例外クラス名, code)` で引き、無ければ上の USER_MESSAGES に落ちる。
#:
#: **「見つかりません」だけでは、利用者は何が無いのか分からない。** 種類を言う。
CLASS_MESSAGES: dict[tuple[str, str], str] = {
    ("AdoptError", "not_found"): "採用する候補が見つかりません。",
    ("AdoptError", "invalid_state"): "いまは採用できません。解析を実行してからお試しください。",
    ("AdoptError", "too_many"): "一度に採用できる件数の上限を超えています。",
    ("CandidateError", "not_found"): "候補が見つからないか、すでに判断済みです。",
    ("ChatRelayError", "not_found"): "対象の実行が見つかりません。",
    ("CurationError", "not_found"): "対象のナレッジ候補が見つかりません。",
    ("DesignTemplateError", "not_found"): "この種類の運営既定デザインはまだ設定されていません。",
    ("DispatcherError", "not_found"): "対象のタスクが見つかりません。",
    ("FileEditError", "not_found"): "ファイルの実体が見つかりません。",
    ("FlowError", "not_found"): "対象の工程が見つかりません。",
    ("PhaseError", "not_found"): "対象のフェーズが見つかりません。",
    ("ResendError", "not_found"): "対象の招待が見つかりません。",
    ("ResendError", "not_pending"): "この招待はすでに使われたか、取り消されています。",
    ("RunControlError", "not_found"): "対象の実行が見つかりません。",
    ("RunControlError", "forbidden"): "この実行を操作する権限がありません。",
    ("RunControlError", "too_many"): (
        "順番待ちの指示が上限に達しています。いまの実行が終わるのを待つか、待ちの指示を減らしてください。"
    ),
    ("ShareError", "not_found"): "共有リンクが見つかりません。",
    ("SheetError", "not_found"): "対象の成果物が見つかりません。",
    ("SheetError", "pdf_view_only"): (
        "PDF はこの画面で表示できますが、直接の編集はできません。"
        "修正は元の成果物を AI に直してもらってから出し直してください。"
    ),
    ("SheetError", "not_editable"): "この成果物は編集できません。",
    ("SheetError", "unsupported"): (
        "この成果物は表形式ではありません。HTML の成果物は本文プレビューで開けます。"
    ),
    ("FileEditError", "unsupported"): "この形式はファイル編集に対応していません。",
    ("ArtifactIngestError", "unsupported"): "この形式の取り込みには対応していません。",
    ("VersionDiffError", "too_large"): "差分が大きすぎて表示できません。版を分けてご確認ください。",
    ("ChatAttachmentError", "too_large"): "添付ファイルの大きさが上限を超えています。",
    ("EmployeeIconError", "too_large"): "画像の大きさが上限を超えています。",
    (
        "MockReviseError",
        "conflict",
    ): "ほかの編集と競合しました。最新の内容を読み直してからお試しください。",
    ("OutputReviseError", "no_html"): "この成果物には、AI が改訂できる内容がありません。",
    ("ShareError", "no_html"): "この成果物には、共有できる内容がありません。",
    ("CurationError", "llm_unconfigured"): (
        "運営側の AI の鍵が設定されていないため実行できません。"
        "サーバーの設定 (環境変数) をご確認ください。"
    ),
    ("CurationError", "security"): (
        "特定可能な情報が残っているため公開できません。匿名化してから、もう一度お試しください。"
    ),
    ("PhaseProposalError", "rate_limited"): (
        "フェーズ提案は少し時間をおいてからでないと実行できません。"
    ),
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
    specific = CLASS_MESSAGES.get((type(exc).__name__, code))
    if specific:
        return specific
    return USER_MESSAGES.get(code, UNHANDLED_MESSAGE)
