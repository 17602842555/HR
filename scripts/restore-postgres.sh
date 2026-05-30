#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-${POSTGRES_DATABASE:-postgres}}"
APP_ENV="${APP_ENV:-development}"

usage() {
  cat <<USAGE
Usage:
  scripts/restore-postgres.sh <backup-file.dump> --yes

Environment:
  POSTGRES_SERVICE=postgres
  POSTGRES_USER=postgres
  POSTGRES_PASSWORD=...
  POSTGRES_DB=oa
  APP_ENV=development|staging|production

Production guard:
  APP_ENV=production ALLOW_PRODUCTION_RESTORE=1 scripts/restore-postgres.sh <backup-file.dump> --yes
USAGE
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  if ! command_exists "$1"; then
    echo "Missing required command: $1" >&2
    exit 127
  fi
}

database_url_for_pg_cli() {
  node - "$DATABASE_URL" <<'NODE'
const raw = process.argv[2] || "";
try {
  const url = new URL(raw);
  ["schema", "connection_limit", "pool_timeout"].forEach((key) => url.searchParams.delete(key));
  console.log(url.toString());
} catch {
  console.log(raw);
}
NODE
}

sha256_file() {
  if command_exists shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    require_command sha256sum
    sha256sum "$1" | awk '{print $1}'
  fi
}

metadata_value() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }' "$file"
}

backup_file="${1:-}"
confirm="${2:-}"

if [[ -z "$backup_file" || "$backup_file" == "-h" || "$backup_file" == "--help" ]]; then
  usage
  exit 64
fi

if [[ "$confirm" != "--yes" && "${RESTORE_YES:-0}" != "1" ]]; then
  echo "Restore is destructive. Re-run with --yes after confirming the target database." >&2
  exit 64
fi

if [[ "$APP_ENV" == "production" && "${ALLOW_PRODUCTION_RESTORE:-0}" != "1" ]]; then
  echo "Production restore blocked. Set ALLOW_PRODUCTION_RESTORE=1 after incident approval." >&2
  exit 65
fi

if [[ ! -f "$backup_file" ]]; then
  echo "Backup file not found: $backup_file" >&2
  exit 66
fi

metadata_sidecar="$backup_file.meta"
expected_sha="$(metadata_value "$metadata_sidecar" sha256 || true)"
if [[ -n "$expected_sha" ]]; then
  actual_sha="$(sha256_file "$backup_file")"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "Database backup checksum mismatch. expected=$expected_sha actual=$actual_sha" >&2
    exit 66
  fi
fi

metadata_artifact_type="$(metadata_value "$metadata_sidecar" artifact_type || true)"
if [[ -n "$metadata_artifact_type" && "$metadata_artifact_type" != "database" ]]; then
  echo "Database backup metadata artifact_type mismatch. expected=database actual=$metadata_artifact_type" >&2
  exit 66
fi

metadata_database="$(metadata_value "$metadata_sidecar" database || true)"
if [[ -n "$metadata_database" && "$metadata_database" != "$POSTGRES_DB" && "${ALLOW_RESTORE_DATABASE_MISMATCH:-0}" != "1" ]]; then
  echo "Database backup metadata database mismatch. expected=$POSTGRES_DB actual=$metadata_database. Set ALLOW_RESTORE_DATABASE_MISMATCH=1 only for an approved cross-database recovery." >&2
  exit 66
fi

metadata_app_env="$(metadata_value "$metadata_sidecar" app_env || true)"
if [[ -n "$metadata_app_env" && "$metadata_app_env" != "$APP_ENV" && "${ALLOW_RESTORE_ENV_MISMATCH:-0}" != "1" ]]; then
  echo "Database backup metadata app_env mismatch. expected=$APP_ENV actual=$metadata_app_env. Set ALLOW_RESTORE_ENV_MISMATCH=1 only for an approved cross-environment recovery." >&2
  exit 66
fi

echo "Restoring '$backup_file' into database '$POSTGRES_DB' in '$APP_ENV'."
metadata_file="$(mktemp "${TMPDIR:-/tmp}/oa-restore-audit.XXXXXX")"
trap 'rm -f "$metadata_file"' EXIT
cat > "$metadata_file" <<EOF
restored_at=$(date -u +%Y%m%d-%H%M%S)
app_env=$APP_ENV
database=$POSTGRES_DB
service=$POSTGRES_SERVICE
restore_file=$backup_file
sha256=${expected_sha:-$(sha256_file "$backup_file")}
EOF

if [[ -n "${DATABASE_URL:-}" && "${BACKUP_USE_LOCAL_PG_RESTORE:-0}" == "1" ]]; then
  require_command node
  require_command pg_restore
  pg_cli_database_url="$(database_url_for_pg_cli)"
  PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_restore \
    --clean \
    --if-exists \
    --no-owner \
    --no-acl \
    --single-transaction \
    --exit-on-error \
    --dbname="$pg_cli_database_url" \
    "$backup_file"
else
  require_command docker
  docker compose version >/dev/null

  if [[ "$backup_file" == *.gz ]]; then
    require_command gzip
    gzip -dc "$backup_file" | docker compose exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$POSTGRES_SERVICE" \
      pg_restore \
        --clean \
        --if-exists \
        --no-owner \
        --no-acl \
        --single-transaction \
        --exit-on-error \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB"
  else
    docker compose exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$POSTGRES_SERVICE" \
      pg_restore \
        --clean \
        --if-exists \
        --no-owner \
        --no-acl \
        --single-transaction \
        --exit-on-error \
        --username="$POSTGRES_USER" \
        --dbname="$POSTGRES_DB" < "$backup_file"
  fi
fi

if [[ "${SKIP_OPS_AUDIT:-0}" != "1" ]]; then
  if node "$ROOT_DIR/scripts/ops-audit.mjs" ops.restore "$metadata_file"; then
    echo "Ops audit recorded for restore."
  elif [[ "${OPS_AUDIT_REQUIRED:-0}" == "1" ]]; then
    echo "Restore succeeded, but required ops audit failed." >&2
    exit 67
  else
    echo "Restore succeeded, but ops audit was not recorded. Set OPS_AUDIT_REQUIRED=1 to make this fatal." >&2
  fi
fi

echo "Restore complete. Run app/API smoke checks before returning traffic."
