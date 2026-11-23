#!/usr/bin/env bash
set -Eeuo pipefail

: "${RESTORE_DATABASE_URL:?Set RESTORE_DATABASE_URL to a fresh disposable database}"
backup_uri="${1:?Usage: scripts/restore-drill.sh s3://bucket/prefix/backup.dump}"
command -v aws >/dev/null || { echo 'AWS CLI is required' >&2; exit 127; }
command -v pg_restore >/dev/null || { echo 'pg_restore is required' >&2; exit 127; }
tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT
aws s3 cp "$backup_uri" "$tmp_file" --only-show-errors
pg_restore --list "$tmp_file" >/dev/null
pg_restore --exit-on-error --no-owner --no-privileges --dbname "$RESTORE_DATABASE_URL" "$tmp_file"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.workshops') IS NOT NULL AND to_regclass('public.sync_channel_states') IS NOT NULL" | grep -qx t
echo 'Restauración verificada en la base desechable indicada.'
