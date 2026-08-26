"""service が投げる code が、すべて日本語の文言に翻訳できることを守る (GAP-225)。

`user_detail()` は表に無い code を **「サーバー側で問題が発生しました」** に倒す。
英語が漏れないという点では安全だが、**利用者は何が起きたのか分からない**。
実際 2026-08-26 時点で、service が使う 72 個の code のうち **表にあったのは 25 個**
だけだった。残り 47 個は、route が `exc.message` (英語の内部文) をそのまま返して
いたので表に入れる必要が無かった — つまり **表の穴と、英語漏れは同じ穴**だった。

英語漏れを塞いだ以上、表の穴はそのまま「意味の分からない定型文」になる。だから
**穴そのものを検査する**。

この検査が守るのは 2 つ:
  1. 新しい code を足したら、日本語の文言も足さないと通らない
  2. 使われなくなった文言が表に残り続けない (腐った表は読まれなくなる)
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from src.user_messages import CLASS_MESSAGES, USER_MESSAGES

SRC = Path(__file__).resolve().parents[1] / "src"
_JA = re.compile(r"[ぁ-んァ-ン一-龯]")

#: 表に無くてよい code → 理由。**空欄で増やさない。**
_NO_MESSAGE_NEEDED: dict[str, str] = {}


def _raised_pairs() -> set[tuple[str, str]]:
    """`raise XxxError("code", ...)` を全部集める → {(クラス名, code)}。"""
    out: set[tuple[str, str]] = set()
    for path in sorted(SRC.rglob("*.py")):
        if "_generated" in path.parts:
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not (isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call)):
                continue
            func = node.exc.func
            name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
            if not name.endswith("Error") or len(node.exc.args) < 2:
                continue
            first = node.exc.args[0]
            if isinstance(first, ast.Constant) and isinstance(first.value, str):
                out.add((name, first.value))
    return out


_PAIRS = _raised_pairs()


@pytest.mark.parametrize(("cls", "code"), sorted(_PAIRS))
def test_すべてのcodeに日本語がある(cls: str, code: str) -> None:
    if code in _NO_MESSAGE_NEEDED:
        return
    assert (cls, code) in CLASS_MESSAGES or code in USER_MESSAGES, (
        f"{cls}('{code}') に対応する文言が無い。"
        " src/user_messages.py の USER_MESSAGES (または CLASS_MESSAGES) に足してください。"
        " 足さないと利用者には「サーバー側で問題が発生しました」としか出ません"
    )


@pytest.mark.parametrize("code", sorted(USER_MESSAGES))
def test_文言は日本語(code: str) -> None:
    assert _JA.search(USER_MESSAGES[code]), f"{code}: 日本語でない — {USER_MESSAGES[code]}"


@pytest.mark.parametrize(("key", "message"), sorted(CLASS_MESSAGES.items()))
def test_クラス別の文言も日本語(key: tuple[str, str], message: str) -> None:
    assert _JA.search(message), f"{key}: 日本語でない — {message}"


def test_使われていない文言が残っていない() -> None:
    """腐った表は読まれなくなる。**使われていない行は消す。**"""
    used_codes = {code for _cls, code in _PAIRS}
    # 表にしか無い code = service のどこからも投げられていない
    stale = sorted(set(USER_MESSAGES) - used_codes - set(_NO_MESSAGE_NEEDED))
    assert not stale, "service から投げられていない code が表に残っています: " + ", ".join(stale)


def test_クラス別の表が腐っていない() -> None:
    stale = sorted(f"{c}/{k}" for (c, k) in CLASS_MESSAGES if (c, k) not in _PAIRS)
    assert not stale, "投げられていない (クラス, code) が残っています: " + ", ".join(stale)


def test_見張る対象が実際に存在する() -> None:
    assert len(_PAIRS) > 80, f"code をほとんど拾えていない ({len(_PAIRS)} 組)"
