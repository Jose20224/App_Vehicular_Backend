#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?Set DATABASE_URL for the backup role}"
: "${BACKUP_S3_URI:?Set BACKUP_S3_URI, for example s3://private-bucket/vehicular/postgres}"
: "${BACKUP_KMS_KEY_ID:?Set BACKUP_KMS_KEY_ID}"
command -v pg_dump >/dev/null || { echo 'pg_dump is required' >&2; exit 127; }
command -v pg_restore >/dev/null || { echo 'pg_restore is required' >&2; exit 127; }
command -v aws >/dev/null || { echo 'AWS CLI is required' >&2; exit 127; }

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$tmp_dir/vehicular-${stamp}.dump"

pg_dump --format=custom --no-owner --no-privileges --file "$archive" "$DATABASE_URL"
pg_restore --list "$archive" >/dev/null
sha256sum "$archive" > "$archive.sha256"
aws s3 cp "$archive" "${BACKUP_S3_URI%/}/vehicular-${stamp}.dump" --sse aws:kms --sse-kms-key-id "$BACKUP_KMS_KEY_ID" --only-show-errors
aws s3 cp "$archive.sha256" "${BACKUP_S3_URI%/}/vehicular-${stamp}.dump.sha256" --sse aws:kms --sse-kms-key-id "$BACKUP_KMS_KEY_ID" --only-show-errors
echo "Backup verificado y cargado: vehicular-${stamp}.dump"
