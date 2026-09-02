#!/usr/bin/env bash
# spec_gate.sh — テスト仕様書(正本)が「表面をなぞっただけ」でないことを機械検査する。
#
# なぜ必要か:
#   鉄則0 は「実行(STEP 3)より前に正本 screens/*.md と 2系統xlsx を作れ」、
#   鉄則2-8 は「件数は表面積から導出せよ。目標バンドを先に置くな」と書いてある。
#   だが散文の指示は飛ばせる。結果側には completion_gate.sh があるのに、
#   **仕様書側には機械ゲートが無かった**ため、粗い仕様のまま実行に入れてしまう。
#   (姉妹スキル e2e-journey-walkthrough で、77画面/140操作に 38 行の計画を書いて
#    実行に入る事故が実際に起きた。同じ穴を QA 側にも空けておかない。)
#
# 使い方:
#   bash spec_gate.sh <spec-dir> <surface.json>
#     spec-dir     : .qa/test-specs (screens/*.md がある場所)
#     surface.json : e2e-journey-walkthrough/scripts/derive_surface.py の出力
#   exit 0 = 実機実行に進んでよい / exit 2 = 仕様書が不足 (実行禁止)
#
# surface.json が無い場合は先に:
#   python3 <skills>/e2e-journey-walkthrough/scripts/derive_surface.py <repo> \
#       -o .qa/e2e-journey/surface.json
set -euo pipefail

SPEC_DIR="${1:-.qa/test-specs}"
SURFACE="${2:-.qa/e2e-journey/surface.json}"

if [[ ! -d "$SPEC_DIR/screens" ]]; then
  echo "FAIL: $SPEC_DIR/screens がありません (正本を1枚も作っていない)" >&2
  echo "STATUS: 仕様書が不足（実行に進んではならない）" >&2
  exit 2
fi
if [[ ! -f "$SURFACE" ]]; then
  echo "FAIL: $SURFACE がありません。先に derive_surface.py を実行してください" >&2
  echo "STATUS: 仕様書が不足（実行に進んではならない）" >&2
  exit 2
fi

python3 - "$SPEC_DIR" "$SURFACE" <<'PY'
import json, re, sys
from pathlib import Path

spec_dir = Path(sys.argv[1])
surface = json.load(open(sys.argv[2], encoding="utf-8"))

screens = surface.get("screens", [])
# 画面キー(パス)から画面IDらしき断片を拾う (S-303 / s/303 / 303 等)。
def keys_of(screen_path: str) -> set[str]:
    out = set()
    for m in re.finditer(r"(\d{3})", screen_path):
        out.add(m.group(1))
    out.add(Path(screen_path).name)
    return out


def route_of(screen_path: str) -> str:
    """画面パスから URL ルートを導く。

    数字を含まない入口ルート (/login, /signup, /ec, /agent/apply, /) は 3 桁 ID で
    照合できず、正本があるのに「見当たらない」と誤警告していた。パスから実ルートを
    復元し、正本の `ルート: \`/login\`` 宣言と突き合わせる。
    """
    p = screen_path
    p = re.sub(r"^.*?/app(?:/|$)", "/", p)          # apps/web/app/login -> /login
    p = re.sub(r"/\([^)]*\)", "", p)                 # ルートグループ (ec) を除去
    p = re.sub(r"/+", "/", p)
    return p if p.startswith("/") else "/" + p

spec_files = sorted(spec_dir.glob("screens/*.md"))
spec_text = {p: p.read_text(encoding="utf-8", errors="ignore") for p in spec_files}
# 正本が宣言しているルート (`- 画面ID: ... / ルート: \`/login\` / ...`)。
declared_routes: set[str] = set()
for _t in spec_text.values():
    for m in re.finditer(r"ルート:\s*`?(/[^`\s/][^`\s]*|/)`?", _t):
        declared_routes.add(m.group(1).rstrip("/") or "/")
# 仕様ファイルごとの TC 行数 (表の行)。
TC_ROW = re.compile(r"^\|\s*(?:TC-)?[A-Za-z]+[-_]?\d", re.M)
tc_count = {p: len(TC_ROW.findall(t)) for p, t in spec_text.items()}

fails, warns = [], []

if not spec_files:
    fails.append("screens/*.md が 1 枚もありません (鉄則0)")

# --- 1. 画面ごとに正本があるか ---
all_spec_names = " ".join(p.name for p in spec_files)
missing = []
for s in screens:
    path = s["screen"]
    if any(k and k in all_spec_names for k in keys_of(path) if k.isdigit()):
        continue
    if (route_of(path).rstrip("/") or "/") in declared_routes:
        continue
    missing.append(path)
if missing:
    warns.append(
        f"正本が見当たらない画面 {len(missing)} 件 (命名が違うだけの可能性あり): "
        + ", ".join(missing[:8]) + (" ..." if len(missing) > 8 else "")
    )

# --- 2. TC 件数が表面積に対して十分か ---
# 目安: その画面の操作数 + 表示/到達/レスポンシブ/権限/空状態 で最低 (ops + 5)。
ops_by_key = {}
for s in screens:
    for k in keys_of(s["screen"]):
        if k.isdigit():
            ops_by_key[k] = max(ops_by_key.get(k, 0), len(s["ops"]))

thin = []
for p, n in tc_count.items():
    key = next((m for m in re.findall(r"(\d{3})", p.name)), None)
    floor = (ops_by_key.get(key, 0) + 5) if key else 5
    if n < floor:
        thin.append(f"{p.name} ({n}件 < 下限{floor})")
if thin:
    fails.append(
        "TC が表面積に対して不足している画面: " + ", ".join(thin[:10])
        + (f" 他{len(thin)-10}件" if len(thin) > 10 else "")
    )

# --- 3. 2系統 xlsx が生成済みか (鉄則4) ---
qa_root = spec_dir.parent
client = list(qa_root.glob("*クライアント版*.xlsx")) + list(qa_root.glob("*client*.xlsx"))
engineer = list(qa_root.glob("*エンジニア版*.xlsx")) + list(qa_root.glob("*engineer*.xlsx"))
if not client:
    fails.append("クライアント版 xlsx が未生成 (鉄則4)")
if not engineer:
    fails.append("エンジニア版 xlsx が未生成 (鉄則4)")

# --- 4. 期待結果が実装描写になっていないか (鉄則5 / G-09) ---
# **期待結果の列だけ**を見る。ファイル全文を見ると備考欄の環境説明
# (「現状 env 未設定」等) を拾って誤検知する。
AS_IS = re.compile(r"現状|そのまま表示|実装どおり|実装通り|コードのとおり")


def expected_cells(text: str) -> list[str]:
    out = []
    for line in text.splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.split("|")]
        # | (空) | ID | 画面 | 観点 | 項目 | 前提 | 手順 | 期待結果 | 結果 | 備考 |
        if len(cells) >= 9 and re.match(r"^(?:TC-)?[A-Za-z]+[-_]?\d", cells[1]):
            out.append(cells[7])
    return out


as_is_hits = [
    p.name
    for p, t in spec_text.items()
    if any(AS_IS.search(c) for c in expected_cells(t))
]
if as_is_hits:
    warns.append(
        "期待結果が実装描写になっている疑い (鉄則5): " + ", ".join(as_is_hits[:6])
    )

# --- 5. 到達性・空状態・権限・レスポンシブ の観点が入っているか ---
REQUIRED_VIEWS = {
    "到達性": re.compile(r"到達|遷移|リンク|404"),
    "空状態": re.compile(r"0件|空|該当なし|未登録"),
    "権限": re.compile(r"権限|403|ロール|未認証|401"),
    "レスポンシブ": re.compile(r"レスポンシブ|横スクロール|375|768|scrollWidth"),
}
joined = " ".join(spec_text.values())
for label, rx in REQUIRED_VIEWS.items():
    if not rx.search(joined):
        fails.append(f"観点「{label}」の TC が 1 件もありません")

total_tc = sum(tc_count.values())
print(f"正本         = {len(spec_files)} 枚")
print(f"TC 合計      = {total_tc}")
print(f"検出画面     = {len(screens)} / 操作 {surface.get('counts',{}).get('screen_ops',0)}")
for w in warns:
    print(f"WARN: {w}")
for f in fails:
    print(f"FAIL: {f}")

if fails:
    print("STATUS: 仕様書が不足（実行に進んではならない）")
    sys.exit(2)
print("STATUS: 仕様書OK（実機実行に進んでよい）")
PY
