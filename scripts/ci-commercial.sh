#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${DATABASE_URL:?DATABASE_URL is required for commercial CI}"

export APP_ENV="${APP_ENV:-ci}"
export NODE_ENV="${NODE_ENV:-test}"
export SERVER_HOST="${SERVER_HOST:-127.0.0.1}"
export SERVER_PORT="${SERVER_PORT:-8787}"
export API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:${SERVER_PORT}}"
export DEFAULT_TENANT_CODE="${DEFAULT_TENANT_CODE:-default}"
export DEFAULT_ADMIN_EMAIL="${DEFAULT_ADMIN_EMAIL:-admin@oa.local}"
export DEFAULT_ADMIN_PASSWORD="${DEFAULT_ADMIN_PASSWORD:-ci-admin-password-20260530}"
export JWT_SECRET="${JWT_SECRET:-ci-commercial-secret-change-before-release-20260530}"
export COOKIE_MAX_AGE_SECONDS="${COOKIE_MAX_AGE_SECONDS:-28800}"
export AUTH_FAILED_LOGIN_LIMIT="${AUTH_FAILED_LOGIN_LIMIT:-5}"
export AUTH_FAILED_LOGIN_WINDOW_MS="${AUTH_FAILED_LOGIN_WINDOW_MS:-600000}"
export AUTH_FAILED_LOGIN_MAX_KEYS="${AUTH_FAILED_LOGIN_MAX_KEYS:-10000}"
export FILE_STORAGE_DIR="${FILE_STORAGE_DIR:-.ci-files}"
export FILE_MAX_UPLOAD_BYTES="${FILE_MAX_UPLOAD_BYTES:-5242880}"
export IMPORT_MAX_HTML_BYTES="${IMPORT_MAX_HTML_BYTES:-10485760}"
export API_BODY_LIMIT_BYTES="${API_BODY_LIMIT_BYTES:-10551296}"
export RUN_DB_SEED="${RUN_DB_SEED:-1}"
export VITE_REQUIRE_API="${VITE_REQUIRE_API:-1}"
export VITE_DEMO_FALLBACK="${VITE_DEMO_FALLBACK:-0}"
export E2E_PORT="${E2E_PORT:-5174}"
export WEB_ORIGIN="${WEB_ORIGIN:-http://127.0.0.1:${E2E_PORT},http://localhost:${E2E_PORT}}"
export TRUST_PROXY="${TRUST_PROXY:-0}"
export VITE_API_PROXY_TARGET="${VITE_API_PROXY_TARGET:-${API_BASE_URL}}"

EVIDENCE_STARTED_AT="$(date -u +%Y%m%dT%H%M%SZ)"
export COMMERCIAL_EVIDENCE_DIR="${COMMERCIAL_EVIDENCE_DIR:-$ROOT_DIR/commercial-evidence/ci-${EVIDENCE_STARTED_AT}}"
mkdir -p "${COMMERCIAL_EVIDENCE_DIR}"
chmod 700 "${COMMERCIAL_EVIDENCE_DIR}"

export API_LOG="${API_LOG:-$COMMERCIAL_EVIDENCE_DIR/api.log}"
export COMMERCIAL_SMOKE_EVIDENCE_FILE="${COMMERCIAL_SMOKE_EVIDENCE_FILE:-$COMMERCIAL_EVIDENCE_DIR/commercial-smoke.json}"
api_pid=""

cleanup() {
  local exit_code=$?
  if [[ -n "${api_pid}" ]] && kill -0 "${api_pid}" >/dev/null 2>&1; then
    kill "${api_pid}" >/dev/null 2>&1 || true
    wait "${api_pid}" >/dev/null 2>&1 || true
  fi
  if [[ "${exit_code}" -ne 0 && -f "${API_LOG}" ]]; then
    echo "---- API log ----" >&2
    tail -n 200 "${API_LOG}" >&2 || true
  fi
}
trap cleanup EXIT

npm run preflight:commercial
npm run validate:migrations
npm run validate:supply-chain
npm run sbom:generate -- --check --json
npm run brand:check
npm run contract:api
npm run db:generate
npm run db:deploy
npm run db:seed
npm run test:server
NODE_ENV=production npm run build

: >"${API_LOG}"
chmod 600 "${API_LOG}"
node server/src/index.mjs >"${API_LOG}" 2>&1 &
api_pid=$!

for _ in $(seq 1 60); do
  if curl -fsS "${API_BASE_URL}/ready" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${api_pid}" >/dev/null 2>&1; then
    echo "OA API exited before readiness." >&2
    exit 1
  fi
  sleep 1
done

curl -fsS "${API_BASE_URL}/ready" >"${COMMERCIAL_EVIDENCE_DIR}/ready.json"
chmod 600 "${COMMERCIAL_EVIDENCE_DIR}/ready.json"
npm run smoke:commercial

if [[ "${RUN_E2E:-1}" = "1" ]]; then
  npm run test:e2e -- --project=chromium
fi

echo "Commercial CI evidence directory: ${COMMERCIAL_EVIDENCE_DIR}"
