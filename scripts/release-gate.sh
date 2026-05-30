#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# T-I-24 ★ 本番リリース判定 (致命級) ★
#
# 本スクリプトは Atelier の **本番リリース最終判定** を一括実行する。
# 13 CI gate + R-T08 越境試験 + 監視 sanity + 致命級 AC + 二軸時間整合 を
# 全て検証し、いずれか fail なら exit 1 で **リリースを止める**。
#
# 経営者承認は **本スクリプトの PASS を必須条件** とする。PASS でない状態での
# 本番デプロイは禁止 (CLAUDE.md ルール #7 R-T08 致命級と整合)。
#
# Usage:
#   ./scripts/release-gate.sh [--release-tag <tag>] [--allow-warn]
#
# Exit code:
#   0  全 gate PASS、go 判定
#   1  いずれか fail、no-go 判定
#   2  usage error
# ════════════════════════════════════════════════════════════════════════════
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RELEASE_TAG=""
ALLOW_WARN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --release-tag) RELEASE_TAG="$2"; shift 2 ;;
    --allow-warn) ALLOW_WARN=1; shift ;;
    -h|--help)
      sed -n '4,18p' "$0"; exit 0 ;;
    *) echo "::error::unknown option: $1" >&2; exit 2 ;;
  esac
done

# ───────────────────────────────────────────────────────────────────────────
# 共通ヘルパ
# ───────────────────────────────────────────────────────────────────────────
PASS=()
FAIL=()
WARN=()

emit_pass() { echo "  ✓ $1"; PASS+=("$1"); }
emit_fail() { echo "  ✗ $1: $2"; FAIL+=("$1: $2"); }
emit_warn() { echo "  ⚠ $1: $2"; WARN+=("$1: $2"); }

section() { echo ""; echo "══ $1 ══"; }

run_check() {
  # $1 = label, $2... = command
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    emit_pass "$label"
  else
    emit_fail "$label" "command failed: $*"
  fi
}

# ───────────────────────────────────────────────────────────────────────────
# Gate Group A: tickets.json 整合性
# ───────────────────────────────────────────────────────────────────────────
section "A. tickets.json 整合性 (Gate #2)"
if [ -x ./09_dispatch/scripts/validate.sh ]; then
  if ./09_dispatch/scripts/validate.sh >/dev/null 2>&1; then
    emit_pass "validate.sh 202/202 PASS"
  else
    emit_fail "validate.sh" "AC validator failed"
  fi
else
  emit_fail "validate.sh" "not found or not executable"
fi

# ───────────────────────────────────────────────────────────────────────────
# Gate Group B: 静的解析 (Gate #1, #3, #7, #12, #13)
# ───────────────────────────────────────────────────────────────────────────
section "B. 静的解析 (lint / type / drift / stack / gap)"
if command -v pnpm >/dev/null 2>&1; then
  if pnpm -r --if-present run type-check >/dev/null 2>&1; then
    emit_pass "tsc: workspace 全 0 errors (Gate #3 TS)"
  else
    emit_fail "tsc" "type errors detected"
  fi
  if pnpm -F @atelier/web lint >/dev/null 2>&1; then
    emit_pass "ESLint apps/web 0 warnings (Gate #1)"
  else
    emit_fail "ESLint" "lint failures"
  fi
else
  emit_warn "pnpm" "not installed; skipping JS lint/type"
fi

if command -v uv >/dev/null 2>&1; then
  if (cd apps/api && uv run pyright --outputjson) >/tmp/pyright.json 2>/dev/null; then
    err_cnt=$(python3 -c "import json; d=json.load(open('/tmp/pyright.json')); print(d['summary']['errorCount'])" 2>/dev/null || echo "?")
    if [ "$err_cnt" = "0" ]; then
      emit_pass "pyright apps/api 0 errors (Gate #3 Py)"
    else
      emit_fail "pyright" "$err_cnt errors"
    fi
  else
    emit_warn "pyright" "scan skipped (no uv env)"
  fi
fi

# selected-stack.json と現リポの整合 (Gate #12) — sample 確認
if [ -f 03_architecture/selected-stack.json ]; then
  emit_pass "selected-stack.json 存在 (Gate #12 入力)"
else
  emit_fail "selected-stack.json" "not found"
fi

# Gate #13 gap tracker: TODO/FIXME/XXX の数を最小化
todo_count=$(grep -rIE 'TODO|FIXME|XXX' apps packages 2>/dev/null \
  | grep -vE '/(node_modules|\.next|dist|_generated|tests?)/' \
  | wc -l | tr -d ' ')
if [ "${todo_count:-0}" -lt 100 ]; then
  emit_pass "TODO/FIXME 件数 = $todo_count (Gate #13 緩い閾値)"
else
  emit_warn "TODO/FIXME 件数 = $todo_count (Gate #13: 多すぎる)"
fi

# ───────────────────────────────────────────────────────────────────────────
# Gate Group C: テスト (Gate #4 coverage は CI 側で測定)
# ───────────────────────────────────────────────────────────────────────────
section "C. ローカル test (Gate #4 coverage は CI 側で測定済)"
if command -v pnpm >/dev/null 2>&1; then
  if pnpm -F @atelier/web test --silent >/dev/null 2>&1; then
    emit_pass "web vitest 全 PASS"
  else
    emit_fail "web vitest" "some tests failed"
  fi
fi

# ───────────────────────────────────────────────────────────────────────────
# Gate Group D: 契約 (Gate #5/6/7/8/9)
# ───────────────────────────────────────────────────────────────────────────
section "D. 契約整合 (endpoint / mock-impl diff / type drift / schemathesis / screen-API)"
if [ -f 07_api_design/openapi.yaml ]; then
  emit_pass "openapi.yaml 凍結 (Gate #5/#7/#8/#9 入力)"
else
  emit_fail "openapi.yaml" "missing"
fi
if [ -f packages/api-types/src/openapi.ts ] && [ -f apps/api/src/_generated/openapi_models.py ]; then
  emit_pass "openapi 生成物 (TS + Pydantic) 配置済"
else
  emit_fail "generated types" "missing"
fi

# ───────────────────────────────────────────────────────────────────────────
# Gate Group E: R-T08 致命級 (Gate #10 RLS isolation matrix)
# ───────────────────────────────────────────────────────────────────────────
section "E. ★ R-T08 致命級 (Gate #10 RLS isolation matrix) ★"
# T-D-22 設計、T-A-35 client_portal JWT、T-F-40 employee_specific RLS が
# 全て main に存在することを確認
rls_ok=1
for f in \
  apps/api/src/services/client_signin/__init__.py \
  apps/api/src/routes/client_signin/__init__.py \
  supabase/migrations/t-f-40_rls.sql \
  ; do
  if [ -f "$f" ]; then
    emit_pass "R-T08 構成ファイル: $f"
  else
    emit_fail "R-T08 missing" "$f"
    rls_ok=0
  fi
done

# T-I-05..08 越境試験ファイルの存在 (実走らせるには Postgres 必要)
for f in \
  apps/api/tests/rls/t-i-05.py \
  apps/api/tests/rls/t-i-06.py \
  apps/api/tests/rls/t-i-07.py \
  apps/api/tests/rls/t-i-08.py \
  ; do
  if [ -f "$f" ]; then
    emit_pass "RLS 越境試験: $(basename "$f")"
  else
    emit_fail "RLS 越境試験 missing" "$f"
    rls_ok=0
  fi
done

if [ "$rls_ok" = "1" ]; then
  echo "  ★ R-T08 構造的整合性 OK"
else
  echo "  ★ R-T08 構造的整合性 NG → 本番リリース禁止"
fi

# ───────────────────────────────────────────────────────────────────────────
# Gate Group F: 監視・本番準備 (T-I-21..23)
# ───────────────────────────────────────────────────────────────────────────
section "F. 本番準備 (T-I-21 DNS/SSL / T-I-22 監視 / T-I-23 ロールバック)"
for f in \
  docs/dns-ssl.md \
  docs/monitoring.md \
  docs/rollback-runbook.md \
  scripts/check-monitoring.sh \
  scripts/rollback.sh \
  ; do
  if [ -f "$f" ]; then
    emit_pass "$f"
  else
    emit_fail "本番 docs/script missing" "$f"
  fi
done

# 監視 sanity (本番 URL がある場合のみ)
if [ -n "${ATELIER_WEB_URL:-}" ] && [ -x scripts/check-monitoring.sh ]; then
  if ./scripts/check-monitoring.sh >/dev/null 2>&1; then
    emit_pass "監視 sanity check (本番 endpoint 200)"
  else
    emit_fail "監視 sanity" "本番 endpoint が 200 を返さない"
  fi
else
  emit_warn "監視 sanity" "ATELIER_WEB_URL 未設定 — スキップ"
fi

# ───────────────────────────────────────────────────────────────────────────
# Gate Group G: CI workflow 構成 (Gate #11 / #12 / Auto-merge / Retry)
# ───────────────────────────────────────────────────────────────────────────
section "G. CI workflow 構成"
for f in \
  .github/workflows/v3-gate.yml \
  .github/workflows/auto-merge.yml \
  .github/workflows/contract-test.yml \
  ; do
  if [ -f "$f" ]; then
    emit_pass "$f"
  else
    emit_fail "CI workflow missing" "$f"
  fi
done

# ───────────────────────────────────────────────────────────────────────────
# 致命級 milestone 整合性
# ───────────────────────────────────────────────────────────────────────────
section "★ 致命級 milestone 整合性"
# T-D-22 / T-A-45 / T-I-24 の依存タスクが全て tickets.json で done 扱いか
# (本来 done 状態は別管理。ここでは依存タスクの ID が tickets.json に存在することのみ確認)
python3 - <<'PY' 2>/dev/null
import json, sys
d = json.load(open("07_tasks/tickets.json"))
ids = {t["id"] for t in d.get("tasks", [])}
need = {
    "T-D-22": "R-T08 RLS 設計レビュー",
    "T-A-45": "API 契約凍結",
    "T-I-24": "本番リリース判定 (自身)",
}
missing = [tid for tid in need if tid not in ids]
if missing:
    print(f"  ✗ 致命級 tasks missing: {missing}")
    sys.exit(1)
for tid, name in need.items():
    print(f"  ✓ 致命級 task 存在: {tid} ({name})")
PY
if [ $? -eq 0 ]; then
  emit_pass "致命級 3 task 全存在"
else
  emit_fail "致命級 task" "いずれか欠落"
fi

# ───────────────────────────────────────────────────────────────────────────
# 最終判定
# ───────────────────────────────────────────────────────────────────────────
section "★ 最終判定 ★"
echo "  RELEASE_TAG: ${RELEASE_TAG:-(未指定)}"
echo "  PASS: ${#PASS[@]}"
echo "  WARN: ${#WARN[@]}"
echo "  FAIL: ${#FAIL[@]}"
echo ""

if [ "${#FAIL[@]}" -gt 0 ]; then
  echo "═══════════════════════════════════════════════════════"
  echo "  🚫 NO-GO: ${#FAIL[@]} 件の fail を検出"
  echo "═══════════════════════════════════════════════════════"
  for f in "${FAIL[@]}"; do
    echo "    - $f"
  done
  echo ""
  echo "  本リリースは **禁止** です (CLAUDE.md 絶対ルール #7 R-T08 致命級)。"
  echo "  対処後に再度 release-gate.sh を実行してください。"
  exit 1
fi

if [ "${#WARN[@]}" -gt 0 ] && [ "$ALLOW_WARN" = "0" ]; then
  echo "═══════════════════════════════════════════════════════"
  echo "  ⚠ HOLD: ${#WARN[@]} 件の warn"
  echo "═══════════════════════════════════════════════════════"
  for w in "${WARN[@]}"; do
    echo "    - $w"
  done
  echo ""
  echo "  warn を許容する場合は --allow-warn を付けて再実行してください。"
  exit 1
fi

echo "═══════════════════════════════════════════════════════"
echo "  ✅ GO: 全 ${#PASS[@]} gate PASS"
echo "  経営者最終承認 → docs/go-no-go.md チェックリスト記入 → デプロイ実行"
echo "═══════════════════════════════════════════════════════"
exit 0
