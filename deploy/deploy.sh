#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  umask 077
  printf 'DEMO_MODE=true\nSESSION_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
fi
docker compose up -d --build
attempt=0
until curl --fail --silent http://127.0.0.1:8090/api/health; do
  attempt=$((attempt+1))
  if [ "$attempt" -ge 30 ]; then
    docker compose logs --tail=30
    exit 1
  fi
  sleep 2
done
printf '\nBLADE health check passed.\n'
