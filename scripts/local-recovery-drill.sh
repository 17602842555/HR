#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

cd "$ROOT_DIR"

APP_ENV="${APP_ENV:-development}"
NODE_ENV="${NODE_ENV:-development}"
POSTGRES_DB="${POSTGRES_DB:-${POSTGRES_DATABASE:-oa_commercial}}"
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8787}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-120}"
EVIDENCE_STARTED_AT="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_STARTED_AT_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMMERCIAL_EVIDENCE_DIR="${COMMERCIAL_EVIDENCE_DIR:-$ROOT_DIR/commercial-evidence/local-recovery-${EVIDENCE_STARTED_AT}}"
BACKUP_DIR="${BACKUP_DIR:-$COMMERCIAL_EVIDENCE_DIR/backups/postgres}"
FILE_BACKUP_DIR="${FILE_BACKUP_DIR:-$COMMERCIAL_EVIDENCE_DIR/backups/files}"
FILE_STORAGE_DRIVER="${FILE_STORAGE_DRIVER:-local}"
FILE_STORAGE_DIR="${FILE_STORAGE_DIR:-$ROOT_DIR/.local-files}"
OPS_AUDIT_REQUIRED="${OPS_AUDIT_REQUIRED:-1}"

API_BASE_URL="${API_BASE_URL%/}"

export APP_ENV
export NODE_ENV
export POSTGRES_DB
export API_BASE_URL
export BACKUP_DIR
export FILE_BACKUP_DIR
export FILE_STORAGE_DRIVER
export FILE_STORAGE_DIR
export OPS_AUDIT_REQUIRED
export BACKUP_USE_LOCAL_PG_DUMP=1
export BACKUP_USE_LOCAL_PG_RESTORE=1
export FILE_BACKUP_USE_LOCAL=1

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  if ! command_exists "$1"; then
    echo "Missing required command: $1" >&2
    exit 127
  fi
}

prepend_local_postgres_bins() {
  local candidates=()
  if [[ -n "${LOCAL_POSTGRES_BIN_DIR:-}" ]]; then
    candidates+=("$LOCAL_POSTGRES_BIN_DIR")
  fi
  candidates+=(
    "/opt/homebrew/opt/postgresql@16/bin"
    "/opt/homebrew/opt/postgresql@15/bin"
    "/usr/local/opt/postgresql@16/bin"
    "/usr/local/opt/postgresql@15/bin"
  )

  local dir
  for dir in "${candidates[@]}"; do
    if [[ -x "$dir/pg_dump" && -x "$dir/pg_restore" ]]; then
      PATH="$dir:$PATH"
      export PATH
      return 0
    fi
  done
}

wait_for_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
  echo "Waiting for API readiness at $API_BASE_URL/ready."

  while (( SECONDS < deadline )); do
    if node -e '
      const baseUrl = process.argv[1];
      fetch(`${baseUrl}/ready`)
        .then((response) => response.ok ? response.json() : Promise.reject(new Error(String(response.status))))
        .then((payload) => process.exit(payload.ok && payload.database === "ok" && payload.fileStorage === "ok" ? 0 : 1))
        .catch(() => process.exit(1));
    ' "$API_BASE_URL"; then
      echo "API is ready."
      return 0
    fi
    sleep 2
  done

  echo "API did not become ready within ${READY_TIMEOUT_SECONDS}s." >&2
  exit 68
}

write_ready_evidence() {
  local target="$1"
  node - "$API_BASE_URL" "$target" <<'NODE'
const fs = require("node:fs/promises");

async function main() {
  const [baseUrl, target] = process.argv.slice(2);
  const response = await fetch(`${baseUrl}/ready`);
  const text = await response.text();
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  await fs.writeFile(target, `${JSON.stringify({
    kind: "api-readiness",
    capturedAt: new Date().toISOString(),
    baseUrl,
    status: response.status,
    ok: response.ok,
    payload
  }, null, 2)}\n`, { mode: 0o600 });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE
}

masked_database_url() {
  node - "$DATABASE_URL" <<'NODE'
const raw = process.argv[2] || "";
try {
  const url = new URL(raw);
  if (url.password) url.password = "***";
  console.log(url.toString());
} catch {
  console.log("[invalid-database-url]");
}
NODE
}

latest_backup_file() {
  local safe_db
  safe_db="$(printf '%s' "$POSTGRES_DB" | tr -c 'A-Za-z0-9_.-' '_')"

  shopt -s nullglob
  local backups=("$BACKUP_DIR"/"$safe_db"-*.dump)
  shopt -u nullglob

  if (( ${#backups[@]} == 0 )); then
    echo "No backup files found under $BACKUP_DIR for database $POSTGRES_DB." >&2
    exit 69
  fi

  ls -t "${backups[@]}" | head -n 1
}

latest_file_backup() {
  shopt -s nullglob
  local backups=("$FILE_BACKUP_DIR"/file-storage-*.tar.gz)
  shopt -u nullglob

  if (( ${#backups[@]} == 0 )); then
    echo "No file storage backup archives found under $FILE_BACKUP_DIR." >&2
    exit 70
  fi

  ls -t "${backups[@]}" | head -n 1
}

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required for a local recovery drill." >&2
  exit 64
fi

if [[ "$APP_ENV" == "production" ]]; then
  echo "Local recovery drill must not run against production. Use npm run drill:commercial with approved production controls instead." >&2
  exit 65
fi

if [[ "${ALLOW_LOCAL_RECOVERY_DRILL:-0}" != "1" ]]; then
  echo "Local recovery drill restores the target database and file storage. Set ALLOW_LOCAL_RECOVERY_DRILL=1 only for a disposable local/staging target." >&2
  exit 65
fi

if [[ "$FILE_STORAGE_DRIVER" != "local" ]]; then
  echo "Local recovery drill supports FILE_STORAGE_DRIVER=local only; use provider-native storage drill for '$FILE_STORAGE_DRIVER'." >&2
  exit 64
fi

require_command npm
require_command node
prepend_local_postgres_bins
require_command pg_dump
require_command pg_restore
require_command tar

mkdir -p "$COMMERCIAL_EVIDENCE_DIR" "$BACKUP_DIR" "$FILE_BACKUP_DIR"
chmod 700 "$COMMERCIAL_EVIDENCE_DIR"

echo "Running Docker-free local recovery drill."
echo "Environment: APP_ENV=$APP_ENV NODE_ENV=$NODE_ENV API_BASE_URL=$API_BASE_URL DB=$POSTGRES_DB"
echo "Evidence directory: $COMMERCIAL_EVIDENCE_DIR"

npm run preflight:commercial
npm run brand:check
npm run contract:api

wait_for_ready
write_ready_evidence "$COMMERCIAL_EVIDENCE_DIR/pre-restore-ready.json"

echo "Running pre-restore commercial smoke."
COMMERCIAL_SMOKE_EVIDENCE_FILE="$COMMERCIAL_EVIDENCE_DIR/pre-restore-smoke.json" npm run smoke:commercial

echo "Creating local pg_dump backup."
"$ROOT_DIR/scripts/backup-postgres.sh"

echo "Creating local file-storage backup."
"$ROOT_DIR/scripts/backup-files.sh"

backup_file="$(latest_backup_file)"
file_backup="$(latest_file_backup)"

echo "Restoring local database backup: $backup_file"
"$ROOT_DIR/scripts/restore-postgres.sh" "$backup_file" --yes

echo "Restoring local file storage backup: $file_backup"
"$ROOT_DIR/scripts/restore-files.sh" "$file_backup" --yes

echo "Re-applying migrations after local restore."
npm run db:deploy

wait_for_ready
write_ready_evidence "$COMMERCIAL_EVIDENCE_DIR/post-restore-ready.json"

echo "Running post-restore commercial smoke."
COMMERCIAL_SMOKE_EVIDENCE_FILE="$COMMERCIAL_EVIDENCE_DIR/post-restore-smoke.json" npm run smoke:commercial

cat >"$COMMERCIAL_EVIDENCE_DIR/local-recovery-drill-summary.json" <<EOF
{
  "ok": true,
  "kind": "commercial-local-recovery-drill",
  "executionMode": "local-postgres",
  "startedAt": "$EVIDENCE_STARTED_AT_ISO",
  "finishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "apiBaseUrl": "$API_BASE_URL",
  "databaseUrl": "$(masked_database_url)",
  "backupFile": "$backup_file",
  "backupMeta": "$backup_file.meta",
  "fileBackup": "$file_backup",
  "fileBackupMeta": "$file_backup.meta",
  "preRestoreReadyEvidence": "$COMMERCIAL_EVIDENCE_DIR/pre-restore-ready.json",
  "postRestoreReadyEvidence": "$COMMERCIAL_EVIDENCE_DIR/post-restore-ready.json",
  "preRestoreSmokeEvidence": "$COMMERCIAL_EVIDENCE_DIR/pre-restore-smoke.json",
  "postRestoreSmokeEvidence": "$COMMERCIAL_EVIDENCE_DIR/post-restore-smoke.json"
}
EOF
chmod 600 "$COMMERCIAL_EVIDENCE_DIR/local-recovery-drill-summary.json"

mkdir -p "$ROOT_DIR/commercial-evidence"
chmod 700 "$ROOT_DIR/commercial-evidence"
cp "$COMMERCIAL_EVIDENCE_DIR/local-recovery-drill-summary.json" "$ROOT_DIR/commercial-evidence/latest-local-recovery-drill-summary.json"
chmod 600 "$ROOT_DIR/commercial-evidence/latest-local-recovery-drill-summary.json"

cat <<EOF
Local recovery drill completed.
API_BASE_URL=$API_BASE_URL
DATABASE_URL=$(masked_database_url)
BACKUP_FILE=$backup_file
BACKUP_META=$backup_file.meta
FILE_BACKUP=$file_backup
FILE_BACKUP_META=$file_backup.meta
COMMERCIAL_EVIDENCE_DIR=$COMMERCIAL_EVIDENCE_DIR
LOCAL_RECOVERY_DRILL_SUMMARY=$COMMERCIAL_EVIDENCE_DIR/local-recovery-drill-summary.json
LATEST_LOCAL_RECOVERY_DRILL_SUMMARY=$ROOT_DIR/commercial-evidence/latest-local-recovery-drill-summary.json
EOF
