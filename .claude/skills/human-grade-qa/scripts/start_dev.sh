#!/usr/bin/env bash
# start_dev.sh — dev サーバを起動 or 既存稼働を検出する
# Usage: start_dev.sh [port]
# 既に立っていれば起動しない。立っていなければ package.json#scripts.dev を試す。
set -euo pipefail
port="${1:-5173}"

is_up() {
  curl -sSf -o /dev/null --max-time 2 "http://localhost:${port}" && return 0
  curl -sSf -o /dev/null --max-time 2 "http://localhost:${port}/index.html" && return 0
  return 1
}

if is_up; then
  echo "dev already up on :${port}"
  exit 0
fi

if [ -f package.json ]; then
  pm=npm
  [ -f pnpm-lock.yaml ] && pm=pnpm
  [ -f yarn.lock ] && pm=yarn
  echo "starting via $pm run dev (port ${port})..."
  nohup $pm run dev >/tmp/qa-dev-${port}.log 2>&1 &
  echo $! > /tmp/qa-dev-${port}.pid
elif [ -f pyproject.toml ]; then
  echo "starting via uvicorn (best guess)..."
  nohup uvicorn app:app --reload --port "${port}" >/tmp/qa-dev-${port}.log 2>&1 &
  echo $! > /tmp/qa-dev-${port}.pid
else
  echo "no dev script detected. Start your dev server manually then re-run." >&2
  exit 1
fi

# wait up to 30s for boot
for _ in $(seq 1 30); do
  if is_up; then
    echo "dev up on :${port} (pid $(cat /tmp/qa-dev-${port}.pid))"
    exit 0
  fi
  sleep 1
done

echo "dev did not respond on :${port} within 30s. See /tmp/qa-dev-${port}.log" >&2
exit 1
