#!/usr/bin/env bash
set -Eeuo pipefail

: "${API_IMAGE:?Set API_IMAGE to an immutable image tag}"
: "${MIGRATION_IMAGE:?Set MIGRATION_IMAGE to an immutable migration image tag}"
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
compose=(docker compose --env-file backend/.env -f docker-compose.yml -f docker-compose.prod.yml)
"${compose[@]}" pull api migrate
"${compose[@]}" --profile tools run --rm migrate
"${compose[@]}" up -d --no-build --remove-orphans

for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:3000/health >/dev/null; then
    echo "Deployment healthy: $API_IMAGE"
    exit 0
  fi
  sleep 2
done
"${compose[@]}" logs --tail=100 api >&2
echo 'API health check did not pass after deployment.' >&2
exit 1
