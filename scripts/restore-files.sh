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
FILE_STORAGE_DRIVER="${FILE_STORAGE_DRIVER:-local}"
FILE_STORAGE_DIR_INPUT="${FILE_STORAGE_DIR:-}"
FILE_STORAGE_DIR="${FILE_STORAGE_DIR_INPUT:-$ROOT_DIR/.local-files}"
FILE_BACKUP_USE_LOCAL="${FILE_BACKUP_USE_LOCAL:-0}"

usage() {
  cat <<USAGE
Usage:
  scripts/restore-files.sh <file-storage-backup.tar.gz> --yes

Environment:
  API_SERVICE=api
  FILE_STORAGE_DIR=.local-files
  FILE_BACKUP_USE_LOCAL=1
  APP_ENV=development|staging|production

Production guard:
  APP_ENV=production ALLOW_PRODUCTION_FILE_RESTORE=1 scripts/restore-files.sh <backup.tar.gz> --yes
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

assert_safe_local_dir() {
  local dir="$1"
  if [[ -z "$dir" || "$dir" == "/" || "$dir" == "." ]]; then
    echo "Unsafe FILE_STORAGE_DIR for restore: '$dir'" >&2
    exit 66
  fi
}

assert_file_storage_restore_supported() {
  case "$FILE_STORAGE_DRIVER" in
    local) ;;
    s3)
      echo "FILE_STORAGE_DRIVER=s3 uses object storage. This tar restore script only covers local or backed persistent-volume storage; use provider-native object-storage restore and validate storage signoff evidence." >&2
      exit 64
      ;;
    *)
      echo "FILE_STORAGE_DRIVER must be local for this tar restore script; got '$FILE_STORAGE_DRIVER'." >&2
      exit 64
      ;;
  esac

  if [[ "$APP_ENV" == "production" ]]; then
    if [[ -z "$FILE_STORAGE_DIR_INPUT" ]]; then
      echo "Production FILE_STORAGE_DIR must be explicitly configured for file storage restore." >&2
      exit 66
    fi
    if [[ "$FILE_STORAGE_DIR" != /* ]]; then
      echo "Production FILE_STORAGE_DIR must be an absolute path for file storage restore: '$FILE_STORAGE_DIR'" >&2
      exit 66
    fi
    if [[ "$FILE_STORAGE_DIR" == "$ROOT_DIR/.local-files" || "$FILE_STORAGE_DIR" == "/tmp" || "$FILE_STORAGE_DIR" == "/var/tmp" ]]; then
      echo "Production FILE_STORAGE_DIR must not use local demo or temporary storage for file restore: '$FILE_STORAGE_DIR'" >&2
      exit 66
    fi
  fi
}

backup_file="${1:-}"
confirm="${2:-}"

if [[ -z "$backup_file" || "$backup_file" == "-h" || "$backup_file" == "--help" ]]; then
  usage
  exit 64
fi

if [[ "$confirm" != "--yes" && "${RESTORE_YES:-0}" != "1" ]]; then
  echo "File storage restore is destructive. Re-run with --yes after confirming the target directory or volume." >&2
  exit 64
fi

if [[ "$APP_ENV" == "production" && "${ALLOW_PRODUCTION_FILE_RESTORE:-0}" != "1" ]]; then
  echo "Production file restore blocked. Set ALLOW_PRODUCTION_FILE_RESTORE=1 after incident approval." >&2
  exit 65
fi

assert_file_storage_restore_supported

if [[ ! -f "$backup_file" ]]; then
  echo "File storage backup not found: $backup_file" >&2
  exit 66
fi

metadata_sidecar="$backup_file.meta"
expected_sha="$(metadata_value "$metadata_sidecar" sha256 || true)"
if [[ -n "$expected_sha" ]]; then
  actual_sha="$(sha256_file "$backup_file")"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "Backup checksum mismatch. expected=$expected_sha actual=$actual_sha" >&2
    exit 66
  fi
fi

metadata_artifact_type="$(metadata_value "$metadata_sidecar" artifact_type || true)"
if [[ -n "$metadata_artifact_type" && "$metadata_artifact_type" != "file_storage" ]]; then
  echo "File storage backup metadata artifact_type mismatch. expected=file_storage actual=$metadata_artifact_type" >&2
  exit 66
fi

metadata_app_env="$(metadata_value "$metadata_sidecar" app_env || true)"
if [[ -n "$metadata_app_env" && "$metadata_app_env" != "$APP_ENV" && "${ALLOW_RESTORE_ENV_MISMATCH:-0}" != "1" ]]; then
  echo "File storage backup metadata app_env mismatch. expected=$APP_ENV actual=$metadata_app_env. Set ALLOW_RESTORE_ENV_MISMATCH=1 only for an approved cross-environment recovery." >&2
  exit 66
fi

node "$ROOT_DIR/scripts/validate-file-backup.mjs" "$backup_file"

echo "Restoring file storage '$backup_file' into '$APP_ENV'."

metadata_file="$(mktemp "${TMPDIR:-/tmp}/oa-file-restore-audit.XXXXXX")"
trap 'rm -f "$metadata_file"' EXIT

if [[ "$FILE_BACKUP_USE_LOCAL" == "1" ]]; then
  require_command tar
  assert_safe_local_dir "$FILE_STORAGE_DIR"
  mkdir -p "$FILE_STORAGE_DIR"
  find "$FILE_STORAGE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  tar -xzf "$backup_file" -C "$FILE_STORAGE_DIR"
  restored_dir="$FILE_STORAGE_DIR"
  storage_mode="local"
else
  require_command docker
  docker compose version >/dev/null
  restored_dir="$(docker compose exec -T "$API_SERVICE" sh -c 'printf "%s" "${FILE_STORAGE_DIR:-/app/storage/files}"' | tr -d '\r')"
  docker compose exec -T "$API_SERVICE" sh -c '
    set -eu
    dir="${FILE_STORAGE_DIR:-/app/storage/files}"
    if [ -z "$dir" ] || [ "$dir" = "/" ] || [ "$dir" = "." ]; then
      echo "Unsafe FILE_STORAGE_DIR for restore: $dir" >&2
      exit 66
    fi
    mkdir -p "$dir"
    find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    tar -xzf - -C "$dir"
  ' < "$backup_file"
  storage_mode="docker"
fi

cat > "$metadata_file" <<EOF
restored_at=$(date -u +%Y%m%d-%H%M%S)
app_env=$APP_ENV
artifact_type=file_storage
storage_mode=$storage_mode
api_service=$API_SERVICE
file_storage_dir=$restored_dir
restore_file=$backup_file
sha256=${expected_sha:-$(sha256_file "$backup_file")}
EOF

if [[ "${SKIP_OPS_AUDIT:-0}" != "1" ]]; then
  if node "$ROOT_DIR/scripts/ops-audit.mjs" ops.restore "$metadata_file"; then
    echo "Ops audit recorded for file storage restore."
  elif [[ "${OPS_AUDIT_REQUIRED:-0}" == "1" ]]; then
    echo "File storage restore succeeded, but required ops audit failed." >&2
    exit 67
  else
    echo "File storage restore succeeded, but ops audit was not recorded. Set OPS_AUDIT_REQUIRED=1 to make this fatal." >&2
  fi
fi

echo "File storage restore complete. Run file attachment download smoke checks before returning traffic."
