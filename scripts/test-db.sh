#!/usr/bin/env bash
# Make the throwaway Postgres databases the cloud's tests use (cloud/test/), on a server you own:
# orgo_core (core and credit tests), orgo_edge (edge tests) and orgo_it (the router test), each with
# Bops' login and schema (db/provision.sql, password "bops-local", as core-fakes.ts expects). The
# credit tests load a stand-in for orgo-web's ledger into schema public as bops_app, so bops_app may
# create there in orgo_core. Safe to run again. Never point it at a real database.
#
#   scripts/test-db.sh [superuser url to the server]   (default postgres://postgres@127.0.0.1:55432/postgres)
#
# A server for it, if you have none on that port (Homebrew's postgresql@17, say):
#   initdb -D /tmp/bops-pg -U postgres --auth=trust && LC_ALL=en_US.UTF-8 pg_ctl -D /tmp/bops-pg -o "-p 55432" start
set -euo pipefail

admin="${1:-postgres://postgres@127.0.0.1:55432/postgres}"
here="$(cd "$(dirname "$0")/.." && pwd)"

for db in orgo_core orgo_edge orgo_it; do
  if [ -z "$(psql "$admin" -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'")" ]; then
    psql "$admin" -qc "CREATE DATABASE $db"
  fi
  url="${admin%/*}/$db"
  psql "$url" -q -v ON_ERROR_STOP=1 -v bops_app_password=bops-local -f "$here/db/provision.sql" >/dev/null
done
psql "${admin%/*}/orgo_core" -qc "GRANT CREATE ON SCHEMA public TO bops_app"
echo "Test databases ready. Run: npm test"
