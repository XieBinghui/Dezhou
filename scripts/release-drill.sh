#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

REPORT_PATH="data/release-drill-report.json"
START_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

wait_http_ok() {
  local url="$1"
  local retry="$2"
  local i
  for i in $(seq 1 "$retry"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "[release-drill] running rc check..."
npm run rc:check

echo "[release-drill] starting docker compose..."
docker compose up -d --build

echo "[release-drill] checking /health and /ready..."
wait_http_ok "http://localhost:3000/health" 30
wait_http_ok "http://localhost:3000/ready" 30

echo "[release-drill] restart server 3 times..."
for i in 1 2 3; do
  docker compose restart server >/dev/null
  wait_http_ok "http://localhost:3000/ready" 30
done

END_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
mkdir -p data
cat >"$REPORT_PATH" <<JSON
{
  "ok": true,
  "startedAt": "$START_TS",
  "endedAt": "$END_TS",
  "checks": {
    "rcCheck": true,
    "dockerComposeUp": true,
    "healthReady": true,
    "restartRecovery3x": true
  }
}
JSON

echo "[release-drill] done: $REPORT_PATH"
