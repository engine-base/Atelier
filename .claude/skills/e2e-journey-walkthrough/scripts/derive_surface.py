#!/usr/bin/env python3
"""表面積(surface area)をリポジトリから機械導出する。

なぜ必要か
----------
SKILL.md [1] は「代表業務を1本、依存順のジャーニー行に落とす」と書いてあるが、
**行数を人間(エージェント)の感覚で決めると必ず粗くなる**。実際に、77画面/5ロール/
140API操作のプロジェクトに対して 38 行のジャーニーを書き、「商品ページ→カート→
購入手続き→確定」を1行に潰して「通した」と報告した事故が起きた。表面だけをなぞる
計画は、通しテストとしては無効。

したがって **行数は入力ではなく出力**にする。このスクリプトが
  (画面, 操作) の組 / エンティティ / CRUD 行列
を実装から数え、plan.json が満たすべき下限を出す。plan_gate.sh がこれを検査する。

使い方
------
    python3 derive_surface.py <repo-root> [-o .qa/e2e-journey/surface.json]

出力 surface.json:
    {
      "screens":   [{"screen": "...", "ops": ["GET /api/...", ...]}, ...],
      "entities":  ["users", "orders", ...],
      "api_routes":["POST /api/...", ...],
      "counts":    {"screens": n, "screen_ops": n, "screens_without_ops": n,
                    "entities": n, "api_routes": n},
      "min_rows":  n,
      "rationale": "..."
    }

汎用性: Next.js(app/pages) / Vite-React / Vue / Svelte / Rails view / Django template
を拾う。取れなくても落ちず、拾えた分だけを根拠として出す(0 なら plan_gate は
「手動で表面積を宣言せよ」と促す)。

検出の前提 (GAP-248 で広げた):
  - 画面 = Next app router の `page.*` (ディレクトリが画面)。画面が呼ぶ操作は
    page.* 本体だけでなく、**その画面ディレクトリ配下の同居コンポーネント**
    (`_components/` 等) からも拾う。app router は操作をほぼ同居コンポーネントに置くので、
    page.* だけを見ると (画面,操作)=0 と数えてしまう。
  - 画面側の操作 = `fetch()` / `axios.<m>()` に加え、任意の API クライアント
    `<obj>.get|post|put|patch|delete("/path")` と `getJson("/path")` /
    `sendJson("POST", "/path")` 形式。path は `/` 始まりか URL のみ (Map.get("id") 等を弾く)。
  - サーバ側ルート = Next route handlers (`export function GET`) に加え、
    FastAPI/Flask 系デコレータ `@router.<m>("/path")` (APIRouter(prefix=) を連結) と
    Express/Fastify 系 `app|router.<m>("/path", handler)`。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

SKIP_DIRS = {
    "node_modules", ".next", ".git", "dist", "build", "out", "coverage",
    ".turbo", ".venv", "venv", "__pycache__", ".qa", "vendor", ".cache",
}

SCREEN_PATTERNS = (
    "page.tsx", "page.jsx", "page.ts", "page.js",          # Next app router
    "index.vue", "App.vue",                                  # Vue
)
SCREEN_SUFFIX = (".vue", ".svelte")

# 画面が呼ぶ操作。method と path を両順序で拾う。
OP_RE = (
    re.compile(r'path:\s*[`"\']([^`"\'\n]+)[`"\'][^}]{0,400}?method:\s*"(\w+)"', re.S),
    re.compile(r'method:\s*"(\w+)"[^}]{0,400}?path:\s*[`"\']([^`"\'\n]+)[`"\']', re.S),
)
FETCH_RE = re.compile(
    r'fetch\(\s*[`"\']([^`"\'\n]+)[`"\'][^)]{0,200}?method:\s*[`"\'](\w+)[`"\']', re.S)
FETCH_GET_RE = re.compile(r'fetch\(\s*[`"\'](/[^`"\'\n]+)[`"\']')
# fetch(`${API_BASE}/path`) — ベース URL をテンプレートで前置する書き方
FETCH_TPL_RE = re.compile(r'fetch\(\s*`\$\{[^}]*\}(/[^`\n]+)`')
AXIOS_RE = re.compile(r'axios\.(get|post|put|patch|delete)\(\s*[`"\']([^`"\'\n]+)[`"\']')
# 任意の API クライアント: client.get("/x") / api.post(`/x/${id}`) / http.delete("/x")。
# path が `/` 始まり (または絶対 URL) のものだけ。Map.get("id") / params.get("q") を弾く。
# サーバ側ルータ (app/router/fastify) は SERVER_CALL_RE の担当なので除外する。
CLIENT_CALL_RE = re.compile(
    r'\b(?!(?:app|router|server|fastify|express)\b)[A-Za-z_$][\w$]*'
    r'\.(get|post|put|patch|delete|del)\(\s*[`"\']((?:/|https?://)[^`"\'\n]*)[`"\']')
# getJson("/x") / fetchJson("/x") / useSWR("/x") → GET
JSON_GET_RE = re.compile(
    r'\b(?:getJson|fetchJson|useSWR|useFetch|swrFetch)(?:<[^>]*>)?\(\s*[`"\']((?:/|https?://)[^`"\'\n]*)[`"\']')
# sendJson("POST", "/x") / request("delete", "/x") → 明示メソッド
JSON_SEND_RE = re.compile(
    r'\b(?:sendJson|request|mutateJson|callApi)(?:<[^>]*>)?\(\s*["\'](get|post|put|patch|delete)["\']\s*,\s*'
    r'[`"\']((?:/|https?://)[^`"\'\n]*)[`"\']', re.I)

# サーバ側ルート (Next route handlers / Express / FastAPI / Rails)
ROUTE_EXPORT_RE = re.compile(r'export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b')
# FastAPI / Flask / Litestar 系デコレータ: @router.get("/x") / @app.post(\n  "/x", ...)
PY_DECOR_RE = re.compile(
    r'@[A-Za-z_][\w.]*\.(get|post|put|patch|delete)\(\s*["\']([^"\'\n]+)["\']')
# APIRouter(prefix="/x") / Blueprint(..., url_prefix="/x") → 同一ファイルのルートに連結
PY_PREFIX_RE = re.compile(r'(?:APIRouter|Blueprint)\([^)]*?(?:url_)?prefix\s*=\s*["\']([^"\']+)["\']', re.S)
# Express / Fastify / Koa-router / Hono: app.get("/x", handler) — 第 2 引数がある呼び出しのみ
SERVER_CALL_RE = re.compile(
    r'\b(?:app|router|server|fastify|express|[A-Za-z_]\w*Router)'
    r'\.(get|post|put|patch|delete)\(\s*[`"\'](/[^`"\'\n]*)[`"\']\s*,')
# テスト・モックのファイルは表面積に数えない
TEST_FILE_RE = re.compile(r'(?:^|/)(?:__tests__|tests?|__mocks__|e2e)/|\.(?:test|spec|stories)\.[cm]?[jt]sx?$|_test\.py$|(?:^|/)test_[^/]*\.py$')

# エンティティ (drizzle / prisma / SQL / Django model)
DRIZZLE_RE = re.compile(r'export\s+const\s+(\w+)\s*=\s*pg(?:Table|View)\(\s*["\'](\w+)["\']')
PRISMA_RE = re.compile(r'^model\s+(\w+)\s*\{', re.M)
SQL_TABLE_RE = re.compile(r'create\s+table\s+(?:if\s+not\s+exists\s+)?["\']?([a-z0-9_]+)', re.I)
DJANGO_RE = re.compile(r'^class\s+(\w+)\(models\.Model\)', re.M)

# 分岐の型 (SKILL.md §8)。通しには最低これだけの枝を織り込む。
BRANCH_KINDS = (
    "happy", "validation", "permission", "empty",
    "limit", "conflict", "cancel", "isolation",
)


def _walk(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".skill")]
        for name in filenames:
            yield Path(dirpath) / name


def _is_screen(path: Path) -> bool:
    if path.name in SCREEN_PATTERNS:
        return True
    if path.suffix in SCREEN_SUFFIX:
        return True
    return False


def _screen_key(path: Path, root: Path) -> str:
    rel = path.relative_to(root)
    if path.name.startswith("page."):
        return str(rel.parent)
    return str(rel)


def _ops_in(text: str) -> list[str]:
    found: list[str] = []
    for m in OP_RE[0].finditer(text):
        found.append(f"{m.group(2).upper()} {m.group(1)}")
    for m in OP_RE[1].finditer(text):
        found.append(f"{m.group(1).upper()} {m.group(2)}")
    for m in FETCH_RE.finditer(text):
        found.append(f"{m.group(2).upper()} {m.group(1)}")
    for m in AXIOS_RE.finditer(text):
        found.append(f"{m.group(1).upper()} {m.group(2)}")
    for m in CLIENT_CALL_RE.finditer(text):
        method = "DELETE" if m.group(1).lower() == "del" else m.group(1).upper()
        found.append(f"{method} {m.group(2)}")
    for m in JSON_SEND_RE.finditer(text):
        found.append(f"{m.group(1).upper()} {m.group(2)}")
    for m in JSON_GET_RE.finditer(text):
        found.append(f"GET {m.group(1)}")
    for m in list(FETCH_GET_RE.finditer(text)) + list(FETCH_TPL_RE.finditer(text)):
        candidate = f"GET {m.group(1)}"
        if not any(c.endswith(m.group(1)) for c in found):
            found.append(candidate)
    # クエリ文字列やテンプレート式の差は同一操作とみなす。
    norm = []
    for f in found:
        norm.append(re.sub(r"\$\{[^}]*\}", "{}", f).split("?")[0].rstrip("/"))
    return sorted(set(norm))


def _server_routes_in(path: Path, root: Path, text: str) -> set[str]:
    routes: set[str] = set()
    # Next route handlers / controllers
    if path.name.startswith("route.") or "/controllers/" in str(path):
        methods = set(ROUTE_EXPORT_RE.findall(text))
        if methods:
            rel = str(path.parent.relative_to(root))
            for method in sorted(methods):
                routes.add(f"{method} /{rel}")
    # FastAPI / Flask 系デコレータ (prefix を連結)
    if path.suffix == ".py":
        prefix = ""
        pm = PY_PREFIX_RE.search(text)
        if pm:
            prefix = pm.group(1).rstrip("/")
        for m in PY_DECOR_RE.finditer(text):
            routes.add(f"{m.group(1).upper()} {prefix}{m.group(2)}")
    # Express / Fastify 系
    if path.suffix in {".ts", ".js", ".mjs", ".cjs"}:
        for m in SERVER_CALL_RE.finditer(text):
            routes.add(f"{m.group(1).upper()} {m.group(2)}")
    return routes


def _nearest_screen(path: Path, screen_dirs: dict[Path, str]) -> str | None:
    """path を含む最も深い画面ディレクトリ (app router の同居コンポーネント帰属)."""
    for parent in path.parents:
        if parent in screen_dirs:
            return screen_dirs[parent]
    return None


def derive(root: Path) -> dict:
    screens: dict[str, list[str]] = {}
    api_routes: set[str] = set()
    entities: set[str] = set()

    sources: list[tuple[Path, str]] = []
    for path in _walk(root):
        suffix = path.suffix.lower()
        if suffix not in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".sql", ".prisma"}:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        sources.append((path, text))

    # パス 1: 画面・サーバルート・エンティティ
    screen_dirs: dict[Path, str] = {}
    for path, text in sources:
        rel_str = str(path.relative_to(root))
        if TEST_FILE_RE.search(rel_str):
            continue
        api_routes |= _server_routes_in(path, root, text)

        for m in DRIZZLE_RE.finditer(text):
            entities.add(m.group(2))
        for m in PRISMA_RE.finditer(text):
            entities.add(m.group(1))
        for m in SQL_TABLE_RE.finditer(text):
            entities.add(m.group(1))
        for m in DJANGO_RE.finditer(text):
            entities.add(m.group(1))

        if _is_screen(path) and "/api/" not in str(path):
            key = _screen_key(path, root)
            screens.setdefault(key, [])
            screens[key].extend(_ops_in(text))
            if path.name.startswith("page."):
                screen_dirs[path.parent] = key

    # パス 2: 画面ディレクトリ配下の同居コンポーネント (_components 等) の操作を
    # 最寄りの画面へ帰属させる。app router は page.* に fetch を書かないことが多い。
    for path, text in sources:
        rel_str = str(path.relative_to(root))
        if TEST_FILE_RE.search(rel_str) or _is_screen(path) or "/api/" in str(path):
            continue
        if path.suffix.lower() not in {".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte"}:
            continue
        key = _nearest_screen(path, screen_dirs)
        if key is None:
            continue
        screens[key].extend(_ops_in(text))

    for key in screens:
        screens[key] = sorted(set(screens[key]))

    screen_ops = sum(len(v) for v in screens.values())
    without_ops = sum(1 for v in screens.values() if not v)
    # 下限の根拠:
    #  - (画面, 操作) の組はそれぞれ 1 行以上 (1行に複数操作を潰さない)
    #  - 操作を持たない画面も到達/表示/遷移で 1 行以上
    #  - 分岐は 8 種すべてを最低 1 本ずつ物語の枝として織り込む (§8)
    min_rows = screen_ops + without_ops + len(BRANCH_KINDS)

    return {
        "screens": [{"screen": k, "ops": v} for k, v in sorted(screens.items())],
        "entities": sorted(entities),
        "api_routes": sorted(api_routes),
        "branch_kinds": list(BRANCH_KINDS),
        "counts": {
            "screens": len(screens),
            "screen_ops": screen_ops,
            "screens_without_ops": without_ops,
            "entities": len(entities),
            "api_routes": len(api_routes),
        },
        "min_rows": min_rows,
        "rationale": (
            f"(画面,操作) {screen_ops} + 操作なし画面 {without_ops} + 分岐種別 "
            f"{len(BRANCH_KINDS)} = {min_rows}。行数は感覚で決めず、この下限以上にする。"
            " 1行に複数操作を潰すと通しではなく要約になる。"
        ),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", help="リポジトリのルート")
    ap.add_argument("-o", "--out", default=".qa/e2e-journey/surface.json")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"error: {root} はディレクトリではありません", file=sys.stderr)
        return 2

    result = derive(root)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")

    counts = result["counts"]
    print(f"surface -> {out}")
    print(f"  画面            = {counts['screens']}")
    print(f"  (画面,操作)     = {counts['screen_ops']}")
    print(f"  操作なし画面    = {counts['screens_without_ops']}")
    print(f"  API ルート      = {counts['api_routes']}")
    print(f"  エンティティ    = {counts['entities']}")
    print(f"  plan 行数の下限 = {result['min_rows']}")
    print(f"  {result['rationale']}")
    if counts["screens"] == 0:
        print("  警告: 画面を1つも検出できませんでした。plan.json に "
              "discovered.surface_manual として表面積を手で宣言してください。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
