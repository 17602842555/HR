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

APP_ENV="${APP_ENV:-development}"
BACKUP_DIR_INPUT="${BACKUP_DIR-}"
FILE_BACKUP_DIR_INPUT="${FILE_BACKUP_DIR-}"
BACKUP_DIR="${BACKUP_DIR_INPUT:-$ROOT_DIR/backups/postgres}"
FILE_BACKUP_DIR="${FILE_BACKUP_DIR_INPUT:-$ROOT_DIR/backups/files}"
PRUNE_DATABASE_KEEP="${PRUNE_DATABASE_KEEP:-14}"
PRUNE_FILE_KEEP="${PRUNE_FILE_KEEP:-14}"
PRUNE_APPLY="${PRUNE_APPLY:-0}"

usage() {
  cat <<USAGE
Usage:
  scripts/prune-backups.sh

Default behavior is dry-run. Set PRUNE_APPLY=1 to delete files.

Environment:
  BACKUP_DIR=backups/postgres
  FILE_BACKUP_DIR=backups/files
  PRUNE_DATABASE_KEEP=14
  PRUNE_FILE_KEEP=14
  PRUNE_APPLY=0|1
  APP_ENV=development|staging|production

Production guard:
  APP_ENV=production ALLOW_PRODUCTION_PRUNE=1 PRUNE_APPLY=1 scripts/prune-backups.sh
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$APP_ENV" == "production" && "$PRUNE_APPLY" == "1" && "${ALLOW_PRODUCTION_PRUNE:-0}" != "1" ]]; then
  echo "Production backup prune blocked. Set ALLOW_PRODUCTION_PRUNE=1 after retention approval." >&2
  exit 65
fi

numeric_keep() {
  local label="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || (( value < 1 )); then
    echo "$label must be a positive integer. Received: $value" >&2
    exit 64
  fi
}

safe_prune_dir() {
  local label="$1"
  local dir="$2"
  if [[ -z "$dir" || "$dir" == "/" || "$dir" == "." ]]; then
    echo "Unsafe $label directory for prune: '$dir'" >&2
    exit 66
  fi
}

safe_production_prune_dir() {
  local label="$1"
  local dir="$2"
  local input="$3"
  if [[ "$APP_ENV" != "production" || "$PRUNE_APPLY" != "1" ]]; then
    return 0
  fi
  if [[ -z "$input" ]]; then
    echo "Production $label must be explicitly configured before backup retention pruning." >&2
    exit 66
  fi
  if [[ "$dir" != /* ]]; then
    echo "Production $label must be an absolute path before backup retention pruning: '$dir'" >&2
    exit 66
  fi
  if [[ "$dir" == "$ROOT_DIR" || "$dir" == "$ROOT_DIR/"* || "$dir" == "/tmp" || "$dir" == "/tmp/"* || "$dir" == "/var/tmp" || "$dir" == "/var/tmp/"* ]]; then
    echo "Production $label must be durable off-app storage, not the project directory or a temporary path: '$dir'" >&2
    exit 66
  fi
}

numeric_keep PRUNE_DATABASE_KEEP "$PRUNE_DATABASE_KEEP"
numeric_keep PRUNE_FILE_KEEP "$PRUNE_FILE_KEEP"
safe_prune_dir BACKUP_DIR "$BACKUP_DIR"
safe_prune_dir FILE_BACKUP_DIR "$FILE_BACKUP_DIR"
safe_production_prune_dir BACKUP_DIR "$BACKUP_DIR" "$BACKUP_DIR_INPUT"
safe_production_prune_dir FILE_BACKUP_DIR "$FILE_BACKUP_DIR" "$FILE_BACKUP_DIR_INPUT"

mkdir -p "$BACKUP_DIR" "$FILE_BACKUP_DIR"

metadata_file="$(mktemp "${TMPDIR:-/tmp}/oa-backup-prune-audit.XXXXXX")"
trap 'rm -f "$metadata_file"' EXIT

deleted_database=0
deleted_file_storage=0
dry_run_database=0
dry_run_file_storage=0

list_newest_first() {
  local dir="$1"
  local pattern="$2"
  find "$dir" -maxdepth 1 -type f -name "$pattern" -exec ls -t {} + 2>/dev/null || true
}

prune_group() {
  local label="$1"
  local dir="$2"
  local pattern="$3"
  local keep="$4"
  local deleted_var="$5"
  local dry_run_var="$6"

  local index=0
  local removed=0
  local planned=0
  local artifact

  while IFS= read -r artifact; do
    [[ -n "$artifact" ]] || continue
    index=$((index + 1))
    if (( index <= keep )); then
      continue
    fi

    if [[ "$PRUNE_APPLY" == "1" ]]; then
      rm -f "$artifact" "$artifact.meta"
      removed=$((removed + 1))
      echo "Deleted stale $label backup: $artifact"
    else
      planned=$((planned + 1))
      echo "Would delete stale $label backup: $artifact"
    fi
  done < <(list_newest_first "$dir" "$pattern")

  if [[ "$PRUNE_APPLY" == "1" ]]; then
    printf -v "$deleted_var" '%s' "$removed"
  else
    printf -v "$dry_run_var" '%s' "$planned"
  fi
}

prune_group "database" "$BACKUP_DIR" "*.dump" "$PRUNE_DATABASE_KEEP" deleted_database dry_run_database
prune_group "file-storage" "$FILE_BACKUP_DIR" "file-storage-*.tar.gz" "$PRUNE_FILE_KEEP" deleted_file_storage dry_run_file_storage

cat > "$metadata_file" <<EOF
pruned_at=$(date -u +%Y%m%d-%H%M%S)
app_env=$APP_ENV
artifact_type=backup_retention
backup_dir=$BACKUP_DIR
file_backup_dir=$FILE_BACKUP_DIR
database_keep=$PRUNE_DATABASE_KEEP
file_storage_keep=$PRUNE_FILE_KEEP
apply=$PRUNE_APPLY
deleted_database=$deleted_database
deleted_file_storage=$deleted_file_storage
dry_run_database=$dry_run_database
dry_run_file_storage=$dry_run_file_storage
EOF

if [[ "$PRUNE_APPLY" == "1" && "${SKIP_OPS_AUDIT:-0}" != "1" ]]; then
  if node "$ROOT_DIR/scripts/ops-audit.mjs" ops.backup_prune "$metadata_file"; then
    echo "Ops audit recorded for backup retention prune."
  elif [[ "${OPS_AUDIT_REQUIRED:-0}" == "1" ]]; then
    echo "Backup prune succeeded, but required ops audit failed." >&2
    exit 67
  else
    echo "Backup prune succeeded, but ops audit was not recorded. Set OPS_AUDIT_REQUIRED=1 to make this fatal." >&2
  fi
fi

if [[ "$PRUNE_APPLY" == "1" ]]; then
  echo "Backup prune complete. Deleted database=$deleted_database file-storage=$deleted_file_storage."
else
  echo "Backup prune dry-run complete. Planned database=$dry_run_database file-storage=$dry_run_file_storage."
fi
