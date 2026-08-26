"""RLS 監査 (Gate #10) の判定そのものを検査する (GAP-221)。

門は「通す/落とす」を間違えると二重に悪い。落とすべきを通せば穴が残り、
**通すべきを落とせば赤が普通になって、本物の穴に誰も気づかなくなる**。
実際 Gate #10 は後者で、意図した default deny を違反と呼び 2026-08-19 以降
ずっと赤だった。だから判定ロジックを直接テストする。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[3]


def _load_audit() -> Any:
    """scripts/ci/rls-audit.py を読み込む (ハイフン入りなので通常の import ができない)。"""
    path = ROOT / "scripts/ci/rls-audit.py"
    spec = importlib.util.spec_from_file_location("rls_audit", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_AUDIT = _load_audit()
audit = _AUDIT.audit
DEFAULT_DENY: dict[str, str] = _AUDIT.DEFAULT_DENY


def _write(tmp: Path, name: str, sql: str) -> None:
    (tmp / name).write_text(sql, encoding="utf-8")


def test_本物のリポジトリで通る() -> None:
    violations, _ = audit(ROOT / "supabase/migrations")
    assert not violations, "\n".join(violations)


def test_RLSが有効でない表は落とす(tmp_path: Path) -> None:
    _write(tmp_path, "a.sql", "create table public.things (id uuid);")
    violations, _ = audit(tmp_path)
    assert any("RLS が有効になっていない" in v for v in violations)


def test_policy0本で宣言も無ければ落とす(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "a.sql",
        "create table public.things (id uuid);\n"
        "alter table public.things enable row level security;\n",
    )
    violations, _ = audit(tmp_path)
    assert any("policy が 1 本も無い" in v for v in violations)


def test_policyがあれば通る(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "a.sql",
        "create table public.things (id uuid);\n"
        "alter table public.things enable row level security;\n"
        "create policy things_select on public.things for select using (true);\n",
    )
    violations, _ = audit(tmp_path)
    # tmp には DEFAULT_DENY の表が無いので「一覧が古い」は必ず出る。
    # ここで見たいのは things についての判定だけ。
    assert not [v for v in violations if v.startswith("things:")]


def test_宣言済みのdefault_denyはrevokeがあれば通る(tmp_path: Path) -> None:
    table = next(iter(DEFAULT_DENY))
    _write(
        tmp_path,
        "a.sql",
        f"create table public.{table} (id uuid);\n"
        f"alter table public.{table} enable row level security;\n"
        f"revoke all on public.{table} from anon, authenticated;\n",
    )
    violations, _ = audit(tmp_path)
    # 他の DEFAULT_DENY 表は「存在しない」で挙がるので、この表についてだけ見る
    assert not [v for v in violations if v.startswith(f"{table}:")]


def test_default_denyなのにrevokeが無ければ落とす(tmp_path: Path) -> None:
    """TRUNCATE は RLS の対象外。権限を残したままだと消せてしまう (実測済み)。"""
    table = next(iter(DEFAULT_DENY))
    _write(
        tmp_path,
        "a.sql",
        f"create table public.{table} (id uuid);\n"
        f"alter table public.{table} enable row level security;\n",
    )
    violations, _ = audit(tmp_path)
    assert any(v.startswith(f"{table}:") and "revoke" in v for v in violations)


@pytest.mark.parametrize("table", sorted(DEFAULT_DENY))
def test_一覧が腐っていないか(table: str) -> None:
    """設計が変わって policy が付いた表が一覧に残っていたら落とす。"""
    violations, _ = audit(ROOT / "supabase/migrations")
    assert not [v for v in violations if v.startswith(f"{table}:")]


def test_理由が空でない() -> None:
    for table, reason in DEFAULT_DENY.items():
        assert reason.strip(), f"{table}: 理由が空 — 空欄で一覧を増やさない"
