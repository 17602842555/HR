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

API_SERVICE="${API_SERVICE:-api}"
APP_ENV="${APP_ENV:-development}"
FILE_BACKUP_DIR_INPUT="${FILE_BACKUP_DIR-}"
FILE_BACKUP_DIR="${FILE_BACKUP_DIR_INPUT:-$ROOT_DIR/backups/files}"
FILE_STORAGE_DRIVER="${FILE_STORAGE_DRIVER:-local}"
FILE_STORAGE_DIR_INPUT="${FILE_STORAGE_DIR:-}"
FILE_STORAGE_DIR="${FILE_STORAGE_DIR_INPUT:-$ROOT_DIR/.local-files}"
FILE_BACKUP_USE_LOCAL="${FILE_BACKUP_USE_LOCAL:-0}"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  if ! command_exists "$1"; then
    echo "Missing required command: $1" >&2
    exit 127
  fi
}

sha256_file() {
  if command_exists shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    require_command sha256sum
    sha256sum "$1" | awk '{print $1}'
  fi
}

safe_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_'
}

assert_file_storage_backup_supported() {
  case "$FILE_STORAGE_DRIVER" in
    local) ;;
    s3)
      echo "FILE_STORAGE_DRIVER=s3 uses object storage. This tar backup script only covers local or backed persistent-volume storage; use provider-native object-storage backup and validate storage signoff evidence." >&2
      exit 64
      ;;
    *)
      echo "FILE_STORAGE_DRIVER must be local for this tar backup script; got '$FILE_STORAGE_DRIVER'." >&2
      exit 64
      ;;
  esac

  if [[ "$APP_ENV" == "production" ]]; then
    if [[ -z "$FILE_STORAGE_DIR_INPUT" ]]; then
      echo "Production FILE_STORAGE_DIR must be explicitly configured for file storage backup." >&2
      exit 66
    fi
    if [[ "$FILE_STORAGE_DIR" != /* ]]; then
      echo "Production FILE_STORAGE_DIR must be an absolute path for file storage backup: '$FILE_STORAGE_DIR'" >&2
      exit 66
    fi
    if [[ "$FILE_STORAGE_DIR" == "$ROOT_DIR/.local-files" || "$FILE_STORAGE_DIR" == "/tmp" || "$FILE_STORAGE_DIR" == "/var/tmp" ]]; then
      echo "Production FILE_STORAGE_DIR must not use local demo or temporary storage for file backup: '$FILE_STORAGE_DIR'" >&2
      exit 66
    fi
  fi
}

assert_file_backup_output_dir() {
  if [[ "$APP_ENV" != "production" ]]; then
    return 0
  fi

  if [[ -z "$FILE_BACKUP_DIR_INPUT" ]]; then
    echo "Production FILE_BACKUP_DIR must be explicitly configured for file storage backups." >&2
    exit 66
  fi
  if [[ "$FILE_BACKUP_DIR" != /* ]]; then
    echo "Production FILE_BACKUP_DIR must be an absolute path for file storage backups: '$FILE_BACKUP_DIR'" >&2
    exit 66
  fi
  if [[ "$FILE_BACKUP_DIR" == "$ROOT_DIR" || "$FILE_BACKUP_DIR" == "$ROOT_DIR/"* || "$FILE_BACKUP_DIR" == "/tmp" || "$FILE_BACKUP_DIR" == "/tmp/"* || "$FILE_BACKUP_DIR" == "/var/tmp" || "$FILE_BACKUP_DIR" == "/var/tmp/"* ]]; then
    echo "Production FILE_BACKUP_DIR must be durable off-app storage, not the project directory or a temporary path: '$FILE_BACKUP_DIR'" >&2
    exit 66
  fi
}

assert_file_storage_backup_supported
assert_file_backup_output_dir

mkdir -p "$FILE_BACKUP_DIR"
umask 077

timestamp="$(date -u +%Y%m%d-%H%M%S)"
safe_env="$(safe_name "$APP_ENV")"
backup_file="$FILE_BACKUP_DIR/file-storage-${safe_env}-${timestamp}.tar.gz"
metadata_file="$backup_file.meta"

echo "Starting file storage backup for '$APP_ENV'."

if [[ "$FILE_BACKUP_USE_LOCAL" == "1" ]]; then
  require_command tar
  mkdir -p "$FILE_STORAGE_DIR"
  file_count="$(find "$FILE_STORAGE_DIR" -type f | wc -l | tr -d ' ')"
  tar -czf "$backup_file" -C "$FILE_STORAGE_DIR" .
  storage_mode="local"
  storage_dir="$FILE_STORAGE_DIR"
else
  require_command docker
  docker compose version >/dev/null
  storage_dir="$(docker compose exec -T "$API_SERVICE" sh -c 'printf "%s" "${FILE_STORAGE_DIR:-/app/storage/files}"' | tr -d '\r')"
  file_count="$(docker compose exec -T "$API_SERVICE" sh -c 'mkdir -p "${FILE_STORAGE_DIR:-/app/storage/files}" && find "${FILE_STORAGE_DIR:-/app/storage/files}" -type f | wc -l' | tr -d ' \r')"
  docker compose exec -T "$API_SERVICE" sh -c 'mkdir -p "${FILE_STORAGE_DIR:-/app/storage/files}" && tar -czf - -C "${FILE_STORAGE_DIR:-/app/storage/files}" .' > "$backup_file"
  storage_mode="docker"
fi

size_bytes="$(wc -c < "$backup_file" | tr -d ' ')"
checksum="$(sha256_file "$backup_file")"

cat > "$metadata_file" <<EOF
created_at=$timestamp
app_env=$APP_ENV
artifact_type=file_storage
storage_mode=$storage_mode
api_service=$API_SERVICE
file_storage_dir=$storage_dir
backup_file=$backup_file
file_count=$file_count
size_bytes=$size_bytes
sha256=$checksum
rpo_target=24h
rto_target=4h
EOF

chmod 600 "$backup_file" "$metadata_file"

if [[ "${SKIP_OPS_AUDIT:-0}" != "1" ]]; then
  if node "$ROOT_DIR/scripts/ops-audit.mjs" ops.backup "$metadata_file"; then
    echo "Ops audit recorded for file storage backup."
  elif [[ "${OPS_AUDIT_REQUIRED:-0}" == "1" ]]; then
    echo "File storage backup succeeded, but required ops audit failed." >&2
    exit 67
  else
    echo "File storage backup succeeded, but ops audit was not recorded. Set OPS_AUDIT_REQUIRED=1 to make this fatal." >&2
  fi
fi

echo "File storage backup complete: $backup_file"
echo "Metadata: $metadata_file"
echo "SHA-256: $checksum"
