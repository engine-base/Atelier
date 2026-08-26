"""自動実行の予定 (cron 式) の指摘が日本語であることを固定する (GAP-225)。

`CronExpressionError` の本文だけは、route が `str(exc)` のまま利用者へ返す。
**利用者が書いた式のどこが悪いか**を指す文言で、置き換えると直し方が分からなく
なるため。その代わり、ここで日本語であることを機械で守る。

日本語で返せる唯一の理由は「利用者の入力についての指摘」だから。**内部の失敗を
この形で返し始めたら、それは英語が漏れる穴になる。**
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

EXPRESSION = Path(__file__).resolve().parents[1] / "src/services/cron/expression.py"
_JA = re.compile(r"[ぁ-んァ-ン一-龯]")


def _messages() -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    for node in ast.walk(ast.parse(EXPRESSION.read_text(encoding="utf-8"))):
        if not (isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call)):
            continue
        func = node.exc.func
        name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
        if name != "CronExpressionError" or not node.exc.args:
            continue
        arg = node.exc.args[0]
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            out.append((node.lineno, arg.value))
        elif isinstance(arg, ast.JoinedStr):
            out.append(
                (
                    node.lineno,
                    "".join(
                        v.value
                        for v in arg.values
                        if isinstance(v, ast.Constant) and isinstance(v.value, str)
                    ),
                )
            )
    return out


_ALL = _messages()


@pytest.mark.parametrize(("line", "message"), _ALL)
def test_指摘は日本語(line: int, message: str) -> None:
    assert _JA.search(message), f"expression.py:{line} が英語のまま: {message}"


def test_見張る対象が実際に存在する() -> None:
    assert len(_ALL) >= 6, f"CronExpressionError の文言をほとんど拾えていない ({len(_ALL)} 件)"
