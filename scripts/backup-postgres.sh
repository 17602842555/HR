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
BACKUP_DIR_INPUT="${BACKUP_DIR-}"
BACKUP_DIR="${BACKUP_DIR_INPUT:-$ROOT_DIR/backups/postgres}"
APP_ENV="${APP_ENV:-development}"

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

assert_production_backup_dir() {
  if [[ "$APP_ENV" != "production" ]]; then
    return 0
  fi

  if [[ -z "$BACKUP_DIR_INPUT" ]]; then
    echo "Production BACKUP_DIR must be explicitly configured for database backups." >&2
    exit 66
  fi
  if [[ "$BACKUP_DIR" != /* ]]; then
    echo "Production BACKUP_DIR must be an absolute path for database backups: '$BACKUP_DIR'" >&2
    exit 66
  fi
  if [[ "$BACKUP_DIR" == "$ROOT_DIR" || "$BACKUP_DIR" == "$ROOT_DIR/"* || "$BACKUP_DIR" == "/tmp" || "$BACKUP_DIR" == "/tmp/"* || "$BACKUP_DIR" == "/var/tmp" || "$BACKUP_DIR" == "/var/tmp/"* ]]; then
    echo "Production BACKUP_DIR must be durable off-app storage, not the project directory or a temporary path: '$BACKUP_DIR'" >&2
    exit 66
  fi
}

assert_production_backup_dir

mkdir -p "$BACKUP_DIR"
umask 077

timestamp="$(date -u +%Y%m%d-%H%M%S)"
safe_db="$(printf '%s' "$POSTGRES_DB" | tr -c 'A-Za-z0-9_.-' '_')"
backup_file="$BACKUP_DIR/${safe_db}-${timestamp}.dump"
metadata_file="$backup_file.meta"

echo "Starting Postgres backup for database '$POSTGRES_DB' in '$APP_ENV'."

if [[ -n "${DATABASE_URL:-}" && "${BACKUP_USE_LOCAL_PG_DUMP:-0}" == "1" ]]; then
  require_command node
  require_command pg_dump
  pg_cli_database_url="$(database_url_for_pg_cli)"
  PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_dump \
    --dbname="$pg_cli_database_url" \
    --format=custom \
    --no-owner \
    --no-acl \
    --file="$backup_file"
else
  require_command docker
  docker compose version >/dev/null
  docker compose exec -T -e PGPASSWORD="${POSTGRES_PASSWORD:-}" "$POSTGRES_SERVICE" \
    pg_dump \
      --username="$POSTGRES_USER" \
      --dbname="$POSTGRES_DB" \
      --format=custom \
      --no-owner \
      --no-acl > "$backup_file"
fi

size_bytes="$(wc -c < "$backup_file" | tr -d ' ')"
if command_exists shasum; then
  checksum="$(shasum -a 256 "$backup_file" | awk '{print $1}')"
else
  require_command sha256sum
  checksum="$(sha256sum "$backup_file" | awk '{print $1}')"
fi

cat > "$metadata_file" <<EOF
created_at=$timestamp
app_env=$APP_ENV
artifact_type=database
database=$POSTGRES_DB
service=$POSTGRES_SERVICE
backup_file=$backup_file
size_bytes=$size_bytes
sha256=$checksum
rpo_target=24h
rto_target=4h
EOF

chmod 600 "$backup_file" "$metadata_file"

if [[ "${SKIP_OPS_AUDIT:-0}" != "1" ]]; then
  if node "$ROOT_DIR/scripts/ops-audit.mjs" ops.backup "$metadata_file"; then
    echo "Ops audit recorded for backup."
  elif [[ "${OPS_AUDIT_REQUIRED:-0}" == "1" ]]; then
    echo "Backup succeeded, but required ops audit failed." >&2
    exit 67
  else
    echo "Backup succeeded, but ops audit was not recorded. Set OPS_AUDIT_REQUIRED=1 to make this fatal." >&2
  fi
fi

echo "Backup complete: $backup_file"
echo "Metadata: $metadata_file"
echo "SHA-256: $checksum"
