#!/usr/bin/env python3
"""CI Gate #6 — mock-impl diff の実照合 (GAP-102 解消)。

旧実装は「ファイル数を数えて常時 PASS」のスタブだった。本スクリプトは
以下を機械検証し、1 件でも違反があれば exit 1 で gate を落とす。

[A] 画面台帳 3-way 突合 (手書きリスト禁止 — 全て機械導出):
    - screens.json (宣言) ∪ 06_mockups/**/*.html の data-bf-screen-id (モック)
      ∪ .qa/test-specs/screens/<ID>.md (QA 仕様書) が 1:1:1 で揃うこと。
    - 宣言済なのにモックが無い / モックがあるのに未宣言 / 仕様書欠落 を FAIL。

[B] モック要素の説明責任 (mock-fidelity の CI 化):
    - 各モック HTML の <button> ラベル (Rule 10 の主対象) を抽出し、
      「apps/web 実装ソース」「当該画面の QA 仕様書」「docs/gap-tracker.md」の
      いずれにも現れないラベルを FAIL とする。
    - 実装済 (ソースに存在) / 監査済で撤去 (仕様書 or gap-tracker に記録) の
      どちらでもない = 黙って落としたモック要素、を検出する。

usage: python3 scripts/ci/mock-impl-diff.py [--root <repo>]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from html.parser import HTMLParser
from pathlib import Path

# ラベルとして意味を持たない短すぎる/記号のみのテキストは対象外。
_MIN_LABEL_LEN = 2
# アイコンフォント名等 (lucide 由来クラス) はラベルではない。
_NOISE = re.compile(r"^[\W\d_]+$")


class _ButtonTextParser(HTMLParser):
    """モック HTML から <button> の可視テキストと screen_id を抽出する。"""

    def __init__(self) -> None:
        super().__init__()
        self.screen_id: str | None = None
        self.labels: set[str] = set()
        self._depth = 0
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        amap = dict(attrs)
        if self.screen_id is None and amap.get("data-bf-screen-id"):
            self.screen_id = amap["data-bf-screen-id"]
        if tag == "button":
            if self._depth == 0:
                self._buf = []
            self._depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag == "button" and self._depth > 0:
            self._depth -= 1
            if self._depth == 0:
                label = strip_count_badge(normalize("".join(self._buf)))
                if len(label) >= _MIN_LABEL_LEN and not _NOISE.match(label):
                    self.labels.add(label)

    def handle_data(self, data: str) -> None:
        if self._depth > 0:
            self._buf.append(data)


def normalize(text: str) -> str:
    """空白圧縮 + NFKC 正規化 (全半角ゆらぎを吸収)。"""
    return unicodedata.normalize("NFKC", re.sub(r"\s+", " ", text)).strip()


def strip_count_badge(label: str) -> str:
    """末尾のカウントバッジ (「すべて7」「関連資料 5」等の動的数値) を落とす。

    バッジ数値はダミーデータでありラベル同一性の一部ではない。
    「選択を再生する 1 件」「テスト結果 8 /」のような複合形も落とす。
    """
    return re.sub(r"(\s*\d+\s*件?\s*/?)+$", "", label).strip()


def load_declared_screens(root: Path) -> dict[str, str]:
    data = json.loads((root / "04_functional_breakdown" / "screens.json").read_text())
    items = data["items"] if isinstance(data, dict) else data
    return {s["id"]: s.get("name", "") for s in items}


def scan_mocks(root: Path) -> dict[str, tuple[Path, set[str]]]:
    """screen_id → (mock path, button labels)。index.html 等 screen_id 無しは無視。"""
    result: dict[str, tuple[Path, set[str]]] = {}
    for path in sorted((root / "06_mockups").rglob("*.html")):
        parser = _ButtonTextParser()
        parser.feed(path.read_text(errors="replace"))
        if parser.screen_id:
            result[parser.screen_id] = (path, parser.labels)
    return result


def build_impl_corpus(root: Path) -> str:
    """apps/web の実装ソースを 1 つの正規化済みコーパスに連結する。"""
    chunks: list[str] = []
    web = root / "apps" / "web"
    for pattern in ("app/**/*.tsx", "app/**/*.ts", "components/**/*.tsx", "lib/**/*.ts"):
        for f in web.glob(pattern):
            if "node_modules" in f.parts or ".next" in f.parts:
                continue
            chunks.append(f.read_text(errors="replace"))
    return normalize(" ".join(chunks))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", help="リポジトリルート")
    args = ap.parse_args()
    root = Path(args.root).resolve()

    declared = load_declared_screens(root)
    mocks = scan_mocks(root)
    spec_dir = root / "apps" / "web" / ".qa" / "test-specs" / "screens"
    gap_tracker = normalize((root / "docs" / "gap-tracker.md").read_text())

    failures: list[str] = []

    # [A] 3-way 台帳突合
    for sid in declared:
        if sid not in mocks:
            failures.append(f"[A] {sid}: 宣言済みだが 06_mockups にモックが無い")
        if not (spec_dir / f"{sid}.md").exists():
            failures.append(f"[A] {sid}: QA 仕様書 apps/web/.qa/test-specs/screens/{sid}.md が無い")
    for sid in mocks:
        if sid not in declared:
            failures.append(f"[A] {sid}: モックが存在するが screens.json に未宣言")

    # [B] モック要素の説明責任
    impl_corpus = build_impl_corpus(root)
    unaccounted_total = 0
    for sid, (mock_path, labels) in sorted(mocks.items()):
        if sid not in declared:
            continue  # [A] で報告済
        spec_path = spec_dir / f"{sid}.md"
        spec_text = normalize(spec_path.read_text()) if spec_path.exists() else ""
        for label in sorted(labels):
            if label in impl_corpus or label in spec_text or label in gap_tracker:
                continue
            unaccounted_total += 1
            failures.append(
                f"[B] {sid} ({mock_path.relative_to(root)}): "
                f"モックのボタン「{label}」が 実装/QA 仕様書/gap-tracker のどこにも無い"
            )

    total_labels = sum(len(labels) for _, labels in mocks.values())
    print(f"Gate #6 — screens: declared={len(declared)} mocks={len(mocks)}")
    print(f"Gate #6 — mock buttons: {total_labels} 個を照合 (未説明 {unaccounted_total})")
    if failures:
        for f in failures:
            print(f"::error::{f}")
        print(f"Gate #6 FAIL — {len(failures)} 件")
        return 1
    print("Gate #6 PASS — 台帳 3-way 一致 + 全モック要素が実装/監査記録で説明済み")
    return 0


if __name__ == "__main__":
    sys.exit(main())
