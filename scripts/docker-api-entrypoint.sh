#!/bin/sh
set -eu

echo "Validating Prisma migration lock..."
npm run validate:migrations

echo "Running database migrations..."
npm run db:deploy

if [ "${RUN_DB_SEED:-0}" = "1" ]; then
  echo "Seeding demo/bootstrap data..."
  npm run db:seed
fi

echo "Starting OA API..."
exec node server/src/index.mjs
