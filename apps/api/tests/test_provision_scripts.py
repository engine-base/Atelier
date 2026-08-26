"""新しい環境を作れる状態を保つ (GAP-220)。

2026-08-26 の通し (J00-04) で、**新しい環境の DB が作れない**ことが分かった。

  1. `scripts/ci/apply-migrations.sh` が辞書順の 1 周だけで適用していたため、
     2 本目の `gap-131_...` が `relation "public.project_credentials" does not
     exist` で停止していた (`gap-*` は `t-d-*` より辞書順で先に来るが、依存は逆)。
     結果、**Gate #14 (real-PG integration) と Gate #15 (browser E2E) は DB を
     用意できず、本体が一度も走っていなかった**。
  2. その先の seed も、`t-d-25.sql` が古い法務文書を `is_current = true` で
     入れ直そうとして部分 unique index に衝突し、`apply-seeds.sh` が exit 3
     になっていた (`deploy.yml` の「Apply DB seeds」も同じ)。

どちらも「一度も新しい環境を作っていなかった」から見えなかった。ここでは
**同じ形の再発**を、DB を立てずに検出できる範囲で止める。実際に流して
確かめるのは CI の DB 用意ステップの役目。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SEED_DIR = ROOT / "supabase/seed"
APPLY_MIGRATIONS = ROOT / "scripts/ci/apply-migrations.sh"

#: seed が触ってはいけない表 = migration が持ち主。
#:
#: 同じ表を seed と migration の両方が書くと、どちらが勝つかは適用順で決まる。
#: 「両方に書いてある」状態そのものが事故なので、表ごとに持ち主を 1 つに決める。
MIGRATION_OWNED_TABLES = {
    "legal_documents": "法務文書は GAP-188/204/208 の migration が正本 (GAP-220)",
}


def _seed_files() -> list[Path]:
    return sorted(SEED_DIR.glob("*.sql"))


def test_seedが存在する() -> None:
    """seed が全部消えたら、AI 社員テンプレが 0 件の DB ができる。"""
    assert _seed_files(), "supabase/seed/*.sql が 1 つも無い"


@pytest.mark.parametrize("table", sorted(MIGRATION_OWNED_TABLES))
def test_seedはmigrationの持ち物を書かない(table: str) -> None:
    offenders = [
        p.name
        for p in _seed_files()
        if re.search(
            rf"\b(insert\s+into|update)\s+(public\.)?{table}\b", p.read_text(encoding="utf-8"), re.I
        )
    ]
    assert not offenders, (
        f"{offenders} が {table} を書いています。{MIGRATION_OWNED_TABLES[table]}。"
        " 同じ表を seed と migration の両方が書くと、適用順で結果が変わります。"
    )


def test_migration適用は依存が解けるまで繰り返す() -> None:
    """1 周で終わる実装に戻ると、また 2 本目で止まる。"""
    src = APPLY_MIGRATIONS.read_text(encoding="utf-8")
    assert "while" in src, "apply-migrations.sh が 1 周しか回していない (GAP-220 の再発)"
    assert "progress" in src, "進捗ゼロで打ち切る条件が見当たらない"


def test_適用できないmigrationは黙って飲み込まない() -> None:
    """「skip した」で緑にすると、表の欠けた DB で緑になる — それが一番危ない。"""
    src = APPLY_MIGRATIONS.read_text(encoding="utf-8")
    assert "exit 1" in src, "収束しなかったときに落ちる経路が無い"
