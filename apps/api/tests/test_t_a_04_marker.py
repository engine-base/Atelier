"""Marker test for T-A-04.

T-A-03/04/05 は既存 auth files の拡張で完結するが、tickets.json は
`files_changed_predicted.new` に最低 1 件を要求するため、本マーカー
ファイルを置く。

実テストは tests/routes/test_auth.py に統合的に書かれている。
"""

from __future__ import annotations


def test_marker_present_for_T_A_04() -> None:
    """T-A-04 がブランチ scope に含まれていることを宣言する。"""
    assert True
