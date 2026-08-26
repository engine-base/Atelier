"""利用者に見せる文言の表が、route の分岐に追いついているかのテスト (GAP-216)。

route は `exc.code` で分岐して HTTP status を決めている。その分岐に登場する
code は **必ず利用者の目に触れる**ので、日本語の文言が要る。表への追記を
忘れても気づけるよう、**route のソースから code を機械的に集めて突き合わせる**。

手で列挙した一覧と比べるテストにすると、route に分岐が増えたときに
一覧の側も一緒に書き換えられてしまい、追いついていないことに気づけない。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from src.errors import UNHANDLED_MESSAGE
from src.user_messages import CLASS_MESSAGES, LEGAL_DOC_NAMES, USER_MESSAGES, user_detail

#: 文言に出てよいラテン文字の語 → 画面のどこで使っているか。
#:
#: もともとこの検査は「ラテン文字を 1 文字も含まない」だった。内部の識別子や
#: クラス名が紛れ込むのを防ぐための**代用**で、狙いとしては正しい。だが
#: GAP-225 で文言を増やしたとき、**利用者が画面でそう呼んでいる語**まで弾いた
#: (AI 社員 / PDF / Excel / Bridge)。「AI の処理に失敗しました」を
#: 「人工知能の処理に…」と書き換えるのは、読みやすさを下げるだけで何も守らない。
#:
#: そこで代用をやめ、**内部の識別子そのもの**を狙って落とす形にする:
#:   - snake_case (`byok_key` `terms_of_service` 等) は常に禁止
#:   - 社内の管理番号 (GAP-xxx) も禁止
#:   - それ以外のラテン語は、この表に載っているものだけ
#: **空欄で増やさない。** 足すのは「画面にその表記で出ている語」だけ。
_PRODUCT_WORDS: dict[str, str] = {
    "AI": "「AI 社員」「AI の処理」— 画面・営業資料ともにこの表記",
    "PDF": "成果物の形式。画面のダウンロード欄がこの表記",
    "HTML": "同上",
    "Excel": "同上",
    "Bridge": "利用者の PC で動く常駐アプリの名前 (画面・設定でこの表記)",
    "PC": "「お使いの PC」— 画面の案内でこの表記",
}


class _Exc:
    """service 層の例外の形だけを真似た test double。"""

    def __init__(self, code: str, subject: str | None = None) -> None:
        self.code = code
        self.subject = subject


_ROUTES = (
    Path(__file__).resolve().parents[1] / "src/routes/auth/__init__.py",
    Path(__file__).resolve().parents[1] / "src/routes/client_signin/__init__.py",
)

_EQ = re.compile(r'exc\.code\s*==\s*"([a-z_]+)"')
_IN = re.compile(r"exc\.code\s+in\s+\(([^)]*)\)")


def _codes_used_in_routes() -> set[str]:
    codes: set[str] = set()
    for path in _ROUTES:
        src = path.read_text(encoding="utf-8")
        codes.update(_EQ.findall(src))
        for group in _IN.findall(src):
            codes.update(re.findall(r'"([a-z_]+)"', group))
    return codes


def test_routeが分岐する全codeに日本語がある() -> None:
    used = _codes_used_in_routes()
    assert used, "route から code を 1 つも取り出せていない (正規表現が古い)"
    missing = sorted(used - USER_MESSAGES.keys())
    assert not missing, f"USER_MESSAGES に日本語が無い code: {missing}"


def test_知らないcodeは想定外扱いの定型文になる() -> None:
    assert user_detail(_Exc("never_seen_before_code")) == UNHANDLED_MESSAGE


@pytest.mark.parametrize(("subject", "expected"), sorted(LEGAL_DOC_NAMES.items()))
def test_足りない同意は日本語の文書名で伝える(subject: str, expected: str) -> None:
    text = user_detail(_Exc("consent_missing", subject))
    assert expected in text
    # 内部名 (terms_of_service 等) がそのまま出ていない
    assert subject not in text


def test_どの同意か分からないときは汎用文に倒す() -> None:
    assert user_detail(_Exc("consent_missing")) == USER_MESSAGES["consent_missing"]


def _internal_words(text: str) -> list[str]:
    """文言に混じった「内部の言葉」を返す (製品名として認めた語は除く)。"""
    return [w for w in re.findall(r"[A-Za-z][A-Za-z_]*", text) if w not in _PRODUCT_WORDS]


@pytest.mark.parametrize("code", sorted(USER_MESSAGES))
def test_文言に英語の内部語が混じっていない(code: str) -> None:
    text = USER_MESSAGES[code]
    # code そのもの (snake_case の英語) が本文に出ていない
    assert code not in text
    assert not re.search(r"\b[a-z]+_[a-z_]+\b", text), f"{code}: 内部名が混じっている — {text}"
    assert not re.search(r"\bGAP-\d+", text), f"{code}: 社内の管理番号が混じっている — {text}"
    assert not _internal_words(text), f"{code}: 見慣れない英語が混じっている — {text}"


@pytest.mark.parametrize(("key", "message"), sorted(CLASS_MESSAGES.items()))
def test_クラス別の文言にも内部語が混じっていない(key: tuple[str, str], message: str) -> None:
    assert not re.search(r"\b[a-z]+_[a-z_]+\b", message), f"{key}: 内部名が混じっている"
    assert not _internal_words(message), f"{key}: 見慣れない英語が混じっている — {message}"


def test_製品名の一覧に理由がある() -> None:
    for word, reason in _PRODUCT_WORDS.items():
        assert reason.strip(), f"{word}: 理由が空 — 空欄で許可を増やさない"


@pytest.mark.parametrize("code", sorted(USER_MESSAGES))
def test_文言が日本語の文になっている(code: str) -> None:
    text = USER_MESSAGES[code]
    assert text.endswith("。"), f"{code}: 文として終わっていない — {text}"
    assert re.search(r"[ぁ-んァ-ン一-龯]", text), f"{code}: 日本語が入っていない — {text}"


def test_routeがexc_messageを直接返していない() -> None:
    """英語の内部メッセージが detail に入る経路をゼロにする (これが本丸)。"""
    for path in _ROUTES:
        src = path.read_text(encoding="utf-8")
        assert "exc.message" not in src, f"{path.name} が exc.message をそのまま返している"
