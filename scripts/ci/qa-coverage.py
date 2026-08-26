#!/usr/bin/env python3
"""QA 正本の「分母」を機械で出す (GAP-211)。

なぜ要るか
----------
2026-08-25、既に存在していた 40 画面 764 項目の正本を一度も開かず、自作スクリプトで
16 項目だけ実行して「一周した」と報告する事故が起きた。実際に触ったのは 45 画面中 10 画面。
**分母が人の頭の中にしか無いと、「やった分」がそのまま「やるべき分」に化ける。**

そこで分母を機械に出させる。このスクリプトは 4 つを見る:

  1. 取りこぼし — 実在する画面に対し、仕様書が無い画面
  2. 鮮度       — 仕様書の最終更新より後に入った変更が反映されているか
  3. 消化率     — 結果列の PASS / 未判定 / BLOCKED / FAIL
  4. AI 正本    — ai-runtime-matrix の件数と鮮度

「全部 PASS」に見えても、①で新機能が圏外だったり ②で古かったりすれば意味が無い。
数字を並べるのは安心のためではなく、**どこが見えていないかを名指しする**ため。

使い方
------
    python3 scripts/ci/qa-coverage.py              # 人が読む
    python3 scripts/ci/qa-coverage.py --json       # CI が読む
    python3 scripts/ci/qa-coverage.py --min-rate 80  # 消化率が下回ったら exit 1
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC_DIR = ROOT / "apps/web/.qa/test-specs"
SCREENS = SPEC_DIR / "screens"
AI_MATRIX = SPEC_DIR / "ai-runtime-matrix.md"
APP_DIR = ROOT / "apps/web/app"

#: 仕様書を持たなくてよい画面 (理由を必ず添える。空欄で増やさない)
SCREEN_EXEMPT = {
    "OAUTH-COMPLETE": "OAuth プロバイダからの戻り専用。人が直接開く画面ではない",
}

#: 結果列の判定。人の印象ではなく、この規則だけで数える。
_PASS = re.compile(r"\b(PASS|FIXED)\b|完了")
_BLOCKED = re.compile(r"\bBLOCKED\b")
_FAIL = re.compile(r"\b(FAIL|NG)\b")
_TC_ROW = re.compile(r"^\|\s*([A-Z][A-Z0-9]*-[0-9v][A-Za-z0-9-]*)\s*\|")


def screen_key(path: str) -> str:
    """`app/projects/s_b01/page.tsx` → `S-B01`。仕様書のファイル名と突き合わせる形に揃える。"""
    return path.split("/")[-1].upper().replace("_", "-")


def implemented_screens() -> set[str]:
    if not APP_DIR.exists():
        return set()
    out = set()
    for page in APP_DIR.rglob("page.tsx"):
        rel = page.relative_to(APP_DIR).parent.as_posix()
        if rel in ("", "."):
            continue  # ルート page.tsx はランディング
        out.add(screen_key(rel))
    return out


def spec_screens() -> set[str]:
    return {p.stem.upper() for p in SCREENS.glob("*.md")} if SCREENS.exists() else set()


def count_rows(paths: list[Path]) -> dict[str, int]:
    """結果列は **ヘッダー行から特定する**。

    正本の表は 1 つの形ではない (実測で 5/6/7/11 セルの 4 種が混在していた)。
    「右から N 番目」で決め打ちすると、形の違う表を丸ごと読み損ねる。実際に
    2026-08-25、決め打ちのせいで 287 行を「未判定」と誤って数え、
    「37% が未判定」という誤った報告をした。**位置ではなく名前で引く。**
    """
    tally = {"passed": 0, "blocked": 0, "failed": 0, "planned": 0, "total": 0, "unreadable": 0}
    for p in paths:
        idx: int | None = None  # 現在の表の結果列。表が変わるたびに引き直す
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            cells = [c.strip() for c in line.split("|")]
            if not line.lstrip().startswith("|"):
                idx = None  # 表の外に出た
                continue
            if not _TC_ROW.match(line):
                # ヘッダー行なら結果列の位置を覚える
                for i, c in enumerate(cells):
                    if c in ("結果", "結果列", "status", "Status"):
                        idx = i
                        break
                continue
            tally["total"] += 1
            result = cells[idx] if idx is not None and idx < len(cells) else None
            if result is None:
                # 結果列を名前で見つけられなかった表。黙って planned に混ぜず、別に数える
                tally["unreadable"] += 1
                continue
            if _FAIL.search(result):
                tally["failed"] += 1
            elif _BLOCKED.search(result):
                tally["blocked"] += 1
            elif _PASS.search(result):
                tally["passed"] += 1
            else:
                tally["planned"] += 1
    return tally


def last_touched(path: Path) -> str:
    try:
        return (
            subprocess.run(
                ["git", "log", "-1", "--format=%ad", "--date=short", "--", str(path)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=30,
            ).stdout.strip()
            or "(記録なし)"
        )
    except Exception:
        return "(取得不可)"


def changes_since(date: str, paths: list[str]) -> int:
    if date in ("(記録なし)", "(取得不可)"):
        return -1
    try:
        out = subprocess.run(
            ["git", "log", f"--since={date}", "--format=%h", "--", *paths],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout.strip()
        return len(out.splitlines()) if out else 0
    except Exception:
        return -1


def build() -> dict:
    impl, spec = implemented_screens(), spec_screens()
    missing = sorted(impl - spec - set(SCREEN_EXEMPT))
    orphan = sorted(spec - impl)
    screen_files = sorted(SCREENS.glob("*.md")) if SCREENS.exists() else []
    screens = count_rows(screen_files)
    ai = (
        count_rows([AI_MATRIX])
        if AI_MATRIX.exists()
        else dict.fromkeys(("passed", "blocked", "failed", "planned", "total", "unreadable"), 0)
    )
    s_date, a_date = last_touched(SCREENS), last_touched(AI_MATRIX)
    total = screens["total"] + ai["total"]
    done = screens["passed"] + ai["passed"]
    return {
        "screens": {
            "implemented": len(impl),
            "with_spec": len(spec),
            "missing_spec": missing,
            "orphan_spec": orphan,
            "last_updated": s_date,
            "changes_since": changes_since(s_date, ["apps/web/app", "apps/web/components"]),
            **screens,
        },
        "ai": {
            "last_updated": a_date,
            "changes_since": changes_since(a_date, ["apps/api/src/services", "apps/bridge/src"]),
            **ai,
        },
        "rate": round(done / total * 100, 1) if total else 0.0,
        "denominator": total,
        "consumed": done,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--json", action="store_true", help="機械可読で出す")
    ap.add_argument("--min-rate", type=float, default=None, help="消化率がこれ未満なら exit 1")
    args = ap.parse_args()

    r = build()
    if args.json:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        s, a = r["screens"], r["ai"]
        print("=" * 66)
        print("QA 正本の分母 (これが「やるべき分」。実行した分ではない)")
        print("=" * 66)
        print(
            f"  画面     実在 {s['implemented']} / 仕様書あり {s['with_spec']}"
            f"   最終更新 {s['last_updated']}"
        )
        if s["missing_spec"]:
            print(
                f"  ⚠ 仕様書が無い画面 {len(s['missing_spec'])} 件: {', '.join(s['missing_spec'])}"
            )
            print("     → この画面は、どれだけ消化しても 1 行も検査されない")
        if s["orphan_spec"]:
            print(f"  ⚠ 画面が無い仕様書 {len(s['orphan_spec'])} 件: {', '.join(s['orphan_spec'])}")
        if s["changes_since"] > 0:
            print(
                f"  ⚠ 仕様書の最終更新以降に画面側の変更が {s['changes_since']} commit 入っている"
            )
            print("     → 反映されているか確かめる (古い正本を 100% 消化しても新機能は圏外)")
        print()
        print(
            f"  画面別 TC   PASS {s['passed']:4} / 未判定 {s['planned']:4}"
            f" / BLOCKED {s['blocked']:3} / FAIL {s['failed']:3}  = 全 {s['total']}"
        )
        if s["unreadable"]:
            print(
                f"  ⚠ 結果列を特定できない行が {s['unreadable']} 件 (表のヘッダーに「結果」が無い)"
            )
            print("     → 数えられていない = 消化の証拠が無い。表の形を揃えること")
        print(
            f"  AI 実動     PASS {a['passed']:4} / 未判定 {a['planned']:4}"
            f" / BLOCKED {a['blocked']:3} / FAIL {a['failed']:3}  = 全 {a['total']}"
            f"   最終更新 {a['last_updated']}"
        )
        if a["changes_since"] > 0:
            print(
                f"  ⚠ AI 正本の最終更新以降に AI 側の変更が {a['changes_since']} commit 入っている"
            )
        print()
        print(f"  消化率  {r['consumed']} / {r['denominator']} = {r['rate']}%")
        print()
        if r["rate"] < 100:
            print(f"  STATUS: 未完了 (残 {r['denominator'] - r['consumed']} 件)")
            print("  → 「完了」「一周した」「通した」等は書けない。残件を名指しで報告すること。")
        else:
            print("  STATUS: 分母は消化済み (ただし分母自体の穴は上の ⚠ を見ること)")
        print("=" * 66)

    if args.min_rate is not None and r["rate"] < args.min_rate:
        print(f"\n❌ 消化率 {r['rate']}% が下限 {args.min_rate}% を下回っています", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
