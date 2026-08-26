#!/usr/bin/env bash
# diff_impact.sh — 差分から影響範囲をざっくり推定
# Usage: diff_impact.sh [base_ref]
# default base: origin/main
set -euo pipefail
base="${1:-origin/main}"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "not a git repo" >&2
  exit 1
fi

git fetch -q origin 2>/dev/null || true

mapfile -t changed < <(git diff --name-only "$base"...HEAD 2>/dev/null || git diff --name-only HEAD)

if [ "${#changed[@]}" -eq 0 ]; then
  echo "## No changes vs $base"
  exit 0
fi

echo "# Diff Impact (base: $base)"
echo
echo "## Direct"
printf '%s\n' "${changed[@]}"

echo
echo "## By category"
{
  for f in "${changed[@]}"; do
    case "$f" in
      src/components/*|src/pages/*|src/features/*|app/*|pages/*|components/*) echo "ui: $f" ;;
      server/*|functions/*|api/*|routes/*|ai_service/*|backend/*) echo "api: $f" ;;
      migrations/*|prisma/*|supabase/migrations/*|db/*) echo "db: $f" ;;
      tests/*|__tests__/*|e2e/*|cypress/*|playwright/*) echo "tests: $f" ;;
      *.env*|vite.config.*|next.config.*|vercel.*|tsconfig.*|package.json|pnpm-lock.yaml) echo "config: $f" ;;
      *.md) echo "docs: $f" ;;
      *) echo "other: $f" ;;
    esac
  done
} | sort | uniq -c | sort -nr

echo
echo "## Importers (1 hop)"
for f in "${changed[@]}"; do
  base_name="$(basename "$f" | sed 's/\.[^.]*$//')"
  [ -z "$base_name" ] && continue
  grep -rlE "from ['\"][^'\"]*${base_name}['\"]|require\(['\"][^'\"]*${base_name}['\"]\)" \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
    src app pages 2>/dev/null | grep -v "^${f}$" || true
done | sort -u | head -40

echo
echo "## Affected routes (guess)"
for f in "${changed[@]}"; do
  case "$f" in
    src/pages/*|app/*|pages/*)
      route="$(echo "$f" | sed -E 's#^(src/)?pages/##; s#^app/##; s#\.[^.]*$##; s#/index$##; s#^#/#' )"
      echo "$route"
      ;;
  esac
done | sort -u

echo
echo "## Affected APIs (guess)"
for f in "${changed[@]}"; do
  case "$f" in
    *Routes.js|*routes.py|api/*|functions/*|routes/*)
      grep -hE '(app|router)\.(get|post|put|delete|patch)\(["'\''`][^"'\''`]+' "$f" 2>/dev/null \
        | sed -E 's/.*\.(get|post|put|delete|patch)\(["'\''`]([^"'\''`]+).*/\1 \2/' | head -20
      ;;
  esac
done | sort -u

echo
echo "## Affected DB (guess)"
for f in "${changed[@]}"; do
  case "$f" in
    migrations/*|prisma/*|*.sql|supabase/migrations/*)
      grep -hE 'create table|alter table|create index' "$f" 2>/dev/null | head -10
      ;;
  esac
done | sort -u

echo
echo "_End._"
