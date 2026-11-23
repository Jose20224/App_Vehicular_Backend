#!/usr/bin/env bash
set -Eeuo pipefail

: "${APP_MIGRATOR_PASSWORD:?Falta APP_MIGRATOR_PASSWORD para crear app_migrator}"
: "${APP_RUNTIME_PASSWORD:?Falta APP_RUNTIME_PASSWORD para crear app_runtime}"

psql \
  --set=ON_ERROR_STOP=1 \
  --username "${POSTGRES_USER}" \
  --dbname "${POSTGRES_DB}" \
  --set=migrator_password="${APP_MIGRATOR_PASSWORD}" \
  --set=runtime_password="${APP_RUNTIME_PASSWORD}" \
  --set=database_name="${POSTGRES_DB}" \
  --file=/docker-entrypoint-initdb.d/01-create-roles.sql.template
