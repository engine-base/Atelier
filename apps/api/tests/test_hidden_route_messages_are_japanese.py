"""関数の陰に置いた detail が、実際に日本語であることを固定する。

`test_route_messages_are_japanese.py` は「route の detail が静的に読めるか」を
見る門で、**読めない書き方は `_HIDDEN_OK` に理由つきで登録して通す**。
登録するだけだと「理由は書いたが中身は英語のまま」を素通りさせてしまうので、
登録した 3 か所の中身をここで押さえる。

対象 (いずれも実行時の値を本文に載せる必要があるもの):
  - GAP-280 PhaseError(open_items).message  … 残件の実数
  - GAP-284 unsupported_file_reason()       … 対応外の拡張子
  - GAP-285 意味検索が使えない理由 + 次の手順
"""

from __future__ import annotations

import re

import pytest

#: ひらがな・カタカナ・漢字のどれかを含むか (英語だけの文言を弾く)
_JA = re.compile(r"[ぁ-んァ-ヶ一-龥]")


def _is_japanese(text: str) -> bool:
    return bool(_JA.search(text))


@pytest.mark.unit
def test_gap284_対応外の形式の理由が日本語で拡張子を含む() -> None:
    from src.services.meetings import unsupported_file_reason

    reason = unsupported_file_reason("メモ.exe", "application/octet-stream")
    assert reason is not None
    assert _is_japanese(reason)
    # 「対応していない」だけでは、利用者は何を直せばいいか分からない
    assert ".exe" in reason
    # 対応形式は None (理由を出さない)
    assert unsupported_file_reason("会議.mp3", "audio/mpeg") is None


@pytest.mark.unit
def test_gap285_意味検索が使えない理由と次の手順が日本語() -> None:
    from src.embeddings.route import resolve_embedding_route

    route = resolve_embedding_route({"ATELIER_LOCAL_EMBEDDING": "0"})
    assert route.state == "unavailable"
    assert _is_japanese(route.reason)
    assert route.next_steps and all(_is_japanese(s) for s in route.next_steps)


@pytest.mark.unit
def test_gap280_残件ありの確定拒否が日本語で件数を含む() -> None:
    """PhaseError(open_items) の本文が日本語で、残っているものを名指しする。"""
    from src.services.flow.phases import PhaseError, open_items_message

    message = open_items_message(
        ["未完了のタスクが 3 件あります", "未解決のコメントが 1 件あります"]
    )
    assert _is_japanese(message)
    assert "3" in message and "1" in message
    exc = PhaseError("open_items", message)
    assert exc.message == message
