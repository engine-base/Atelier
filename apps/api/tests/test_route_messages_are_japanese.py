"""route が利用者へ返す文言が日本語であることを機械で守る (GAP-218)。

2026-08-26 の通しで、サインインの失敗が `invalid email or password` と英語で
出た。直そうとして route 全体を数えたら、`HTTPException(..., "英語")` が
**38 ファイル 283 箇所**残っていた。「タスクが見つかりません」も
「権限がありません」も、日本語の製品なのに全部英語で利用者に届いていた。

翻訳しただけでは、次に route を書く人がまた英語で書く。**書けなくする**のが
このテストの役目。

例外を認めるとき
----------------
機械が読む識別子をそのまま返したい場面 (Webhook の応答など) が将来出たら、
`_ALLOWED` に **理由を添えて** 足す。空欄で増やさないこと。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROUTES = Path(__file__).resolve().parents[1] / "src/routes"

#: HTTPException(status, "文言") の第 2 引数を取り出す
_RAISE = re.compile(
    r'HTTPException\(\s*(?:status\.)?[A-Za-z0-9_]+\s*,\s*(["\'])([^"\']+)\1',
    re.S,
)
_JA = re.compile(r"[ぁ-んァ-ン一-龯]")

#: 日本語でなくてよいもの (理由を必ず書く)。いまは無い。
_ALLOWED: dict[str, str] = {}


def _offenders() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for path in sorted(ROUTES.rglob("*.py")):
        for _quote, message in _RAISE.findall(path.read_text(encoding="utf-8")):
            if _JA.search(message) or message in _ALLOWED:
                continue
            out.append((path.relative_to(ROUTES).as_posix(), message))
    return out


def test_利用者に返す文言はすべて日本語() -> None:
    bad = _offenders()
    assert not bad, "英語のまま利用者に届く文言があります:\n" + "\n".join(
        f"  {f}: {m}" for f, m in bad
    )


def _messages() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for path in sorted(ROUTES.rglob("*.py")):
        for _quote, message in _RAISE.findall(path.read_text(encoding="utf-8")):
            if _JA.search(message):
                out.append((path.relative_to(ROUTES).as_posix(), message))
    return out


@pytest.mark.parametrize(("where", "message"), _messages())
def test_文言に内部の識別子を混ぜない(where: str, message: str) -> None:
    """`byok_key not found` のような内部名が日本語文に紛れ込むのを防ぐ。

    snake_case の識別子や、社内の管理番号 (GAP-xxx) は利用者には意味が無い。
    """
    assert not re.search(r"\b[a-z]+_[a-z_]+\b", message), f"{where}: 内部名が混じっている"
    assert not re.search(r"\bGAP-\d+", message), f"{where}: 社内の管理番号が混じっている"


def test_見張る対象が実際に存在する() -> None:
    """正規表現が古くなって 0 件しか拾えなくなったら、この門は無言で無力化する。"""
    assert len(_messages()) > 100, "route から文言をほとんど拾えていない (正規表現が古い)"
