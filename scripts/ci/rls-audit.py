#!/usr/bin/env python3
"""migration ファイルの静的 RLS 監査 (Gate #10 / R-T08 致命級 / GAP-221)。

なぜ書き直したか
----------------
元の判定は「RLS 有効なのに policy が 0 本 → 違反」だった。だが **policy 0 本は
いちばん強い状態 (default deny)** で、この製品はそれを意図して選んでいる表が
8 つある。成果物の実体・モックの中身・ナレッジ昇格の候補・運営のエラーログ等で、
DDL のコメントにも「service 経路のみ」と書いてある。

結果、Gate #10 は**正しい設計を違反と呼んで落ち続け**、2026-08-19 以降ずっと赤に
なっていた。**赤が普通になった門は、本物の穴を見つけても誰も気づかない。**

そこで判定を 3 つに分ける:

  1. RLS が有効でない                     → 違反 (本物の穴)
  2. policy 0 本 かつ 下の表に載っていない → 違反 (書き忘れの疑い)
  3. policy 0 本 かつ 下の表に載っている   → OK (意図した default deny)

さらに **表が腐らないように**、載っているのに policy を持つ表も違反にする
(設計が変わったのに一覧が古いまま、を防ぐ)。

default deny の表には `revoke` も要る
--------------------------------------
policy が無くても、`grant all on all tables in schema public to authenticated`
のような一括 GRANT を後から流すと **RLS 以前に列が見えてしまう**。実際
GAP-172 で「GRANT が migration の REVOKE を打ち消していた」事故がある。
だから default deny を名乗る表には `revoke ... from ... authenticated` を要求する。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

#: 意図して policy を 1 本も置かない表 → その理由。
#:
#: **空欄で増やさない。** ここに足すということは「アプリの通常経路 (authenticated)
#: からは一切読めない」と宣言することで、読み書きは service 経路 + そこでの
#: 明示的な認可チェックだけになる。
DEFAULT_DENY: dict[str, str] = {
    "artifact_files": "成果物のバイナリ実体。service 経路が署名 URL を発行してから配信する (GAP-145)",
    "mock_contents": "モックの中身。トークン検証付きの取得経路のみ (GAP-137)",
    "knowledge_curations": "ナレッジ昇格の候補。存在自体をテナントに見せない (GAP-153)",
    "error_log": "運営のエラーログ。テナントからは読めない (GAP-182)",
    "error_alerts": "エラー通知の送信記録。運営のみ (GAP-194)",
    "uptime_checks": "外形監視の結果。運営のみ (GAP-195)",
    "capacity_events": "混雑の実績。運営のみ (GAP-205)",
    "capacity_alert_state": "混雑アラートの状態。運営のみ (GAP-205)",
}

_CREATE_TABLE = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([\w_]+)", re.IGNORECASE
)
_CREATE_POLICY = re.compile(
    r"CREATE\s+POLICY\s+[\w_\"]+\s+ON\s+(?:public\.)?([\w_]+)", re.IGNORECASE
)
_ENABLE_RLS = re.compile(
    r"ALTER\s+TABLE\s+(?:public\.)?([\w_]+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY", re.IGNORECASE
)
_REVOKE = re.compile(
    r"REVOKE\s+.*?\s+ON\s+(?:TABLE\s+)?(?:public\.)?([\w_]+)\s+FROM\s+([^\n;]+)", re.IGNORECASE
)


def _is_internal(table: str) -> bool:
    return table.startswith("_") or table in ("schema_migrations", "ar_internal_metadata")


def scan(migration_dir: Path) -> dict[str, object]:
    tables: set[str] = set()
    policies: dict[str, int] = {}
    rls_enabled: set[str] = set()
    revoked: set[str] = set()

    for sql in sorted(migration_dir.rglob("*.sql")):
        # SQL の行コメントを外してから走査する (コメント内の文言への誤マッチ防止)
        text = re.sub(r"--[^\n]*", "", sql.read_text(encoding="utf-8"))
        tables.update(_CREATE_TABLE.findall(text))
        for t in _CREATE_POLICY.findall(text):
            policies[t] = policies.get(t, 0) + 1
        rls_enabled.update(_ENABLE_RLS.findall(text))
        for t, roles in _REVOKE.findall(text):
            if "authenticated" in roles.lower():
                revoked.add(t)

    return {"tables": tables, "policies": policies, "rls_enabled": rls_enabled, "revoked": revoked}


def audit(migration_dir: Path) -> tuple[list[str], str]:
    """違反の一覧と、人が読むサマリーを返す。"""
    r = scan(migration_dir)
    tables: set[str] = r["tables"]  # type: ignore[assignment]
    policies: dict[str, int] = r["policies"]  # type: ignore[assignment]
    rls_enabled: set[str] = r["rls_enabled"]  # type: ignore[assignment]
    revoked: set[str] = r["revoked"]  # type: ignore[assignment]

    violations: list[str] = []
    for t in sorted(tables):
        if _is_internal(t):
            continue
        if t not in rls_enabled:
            violations.append(f"{t}: RLS が有効になっていない")
            continue
        count = policies.get(t, 0)
        if count == 0 and t not in DEFAULT_DENY:
            violations.append(
                f"{t}: RLS は有効だが policy が 1 本も無い。"
                " 意図した default deny なら scripts/ci/rls-audit.py の DEFAULT_DENY に"
                " 理由つきで足すこと (足せば OK になるが、足すのは『通常経路からは"
                " 一切読めない』と宣言することを意味する)"
            )
        if count == 0 and t in DEFAULT_DENY and t not in revoked:
            violations.append(
                f"{t}: default deny を名乗っているのに revoke ... from authenticated が無い。"
                " 一括 GRANT を流されると RLS 以前に見えてしまう (GAP-172 の実例)"
            )

    # 一覧が腐らないように、設計が変わった表を検出する
    for t in sorted(DEFAULT_DENY):
        if t not in tables:
            violations.append(
                f"{t}: DEFAULT_DENY に載っているが、そんな表は存在しない (一覧が古い)"
            )
        elif policies.get(t, 0) > 0:
            violations.append(
                f"{t}: DEFAULT_DENY に載っているのに policy が {policies[t]} 本ある。"
                " 設計が変わったなら一覧から外すこと"
            )

    summary = (
        f"  表 {len(tables)} / RLS 有効 {len(rls_enabled)} / policy {sum(policies.values())} 本"
        f" / 意図した default deny {len(DEFAULT_DENY)}"
    )
    return violations, summary


def main() -> int:
    migration_dir = ROOT / "supabase/migrations"
    if not migration_dir.exists():
        print("::notice::migrations ディレクトリが無い。Gate #10 は構造検査のみで PASS。")
        return 0

    violations, summary = audit(migration_dir)
    print(summary)
    if violations:
        print(f"::error::Gate #10 FAIL (R-T08 致命級) — {len(violations)} 件:")
        for v in violations:
            print(f"  - {v}")
        return 1
    print("Gate #10 PASS — 利用者が触る表はすべて RLS 有効 + policy あり、")
    print("               default deny の表は理由つきで宣言され revoke されている。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
