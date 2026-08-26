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
from src.user_messages import LEGAL_DOC_NAMES, USER_MESSAGES, user_detail


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


@pytest.mark.parametrize("code", sorted(USER_MESSAGES))
def test_文言に英語の内部語が混じっていない(code: str) -> None:
    text = USER_MESSAGES[code]
    # code そのもの (snake_case の英語) が本文に出ていない
    assert code not in text
    # ラテン文字を含まない = 内部の識別子やクラス名が紛れ込んでいない
    assert not re.search(r"[A-Za-z]", text), f"{code}: 英字が混じっている — {text}"


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
