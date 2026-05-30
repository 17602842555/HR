# Deployment And Recovery Runbook

## Expected Runtime

The commercial deployment should run as separate app/API/Postgres services. The scripts in `scripts/` assume a Docker Compose Postgres service by default and can also run against a local `DATABASE_URL` when explicitly requested.

Minimum environment variables:

```bash
APP_ENV=production
NODE_ENV=production
POSTGRES_SERVICE=postgres
POSTGRES_USER=oa
POSTGRES_PASSWORD=<deployment-managed-random-password>
POSTGRES_DB=oa_commercial
JWT_SECRET=<at-least-32-random-characters>
COOKIE_MAX_AGE_SECONDS=28800
AUTH_FAILED_LOGIN_LIMIT=5
AUTH_FAILED_LOGIN_WINDOW_MS=600000
AUTH_FAILED_LOGIN_MAX_KEYS=10000
WEB_ORIGIN=https://oa.company.cn
TRUST_PROXY=0
VITE_REQUIRE_API=1
VITE_DEMO_FALLBACK=0
RUN_DB_SEED=0
ALLOW_PRODUCTION_SEED=0
BACKUP_DIR=/backups/postgres
FILE_BACKUP_DIR=/backups/files
FILE_STORAGE_DRIVER=local
FILE_STORAGE_DIR=/app/storage/files
OBJECT_STORAGE_ENDPOINT=
OBJECT_STORAGE_BUCKET=
OBJECT_STORAGE_REGION=
OBJECT_STORAGE_ACCESS_KEY_ID=
OBJECT_STORAGE_SECRET_ACCESS_KEY=
OBJECT_STORAGE_PREFIX=
OBJECT_STORAGE_FORCE_PATH_STYLE=1
FILE_MAX_UPLOAD_BYTES=5242880
IMPORT_MAX_HTML_BYTES=10485760
API_BODY_LIMIT_BYTES=10551296
PRUNE_DATABASE_KEEP=14
PRUNE_FILE_KEEP=14
```

Local Docker Compose demo stack:

```bash
cp .env.example .env
docker compose up --build -d
npm run smoke:commercial
```

The example env is a local commercial-demo template: it keeps `VITE_REQUIRE_API=1`, disables demo fallback, includes both nginx `8080` and Vite dev origins in `WEB_ORIGIN`, and uses a non-production JWT secret that must be replaced before any production deployment.

Docker-free local PostgreSQL path:

```bash
npm run postgres:local -- check --json
# If PostgreSQL binaries are missing: brew install postgresql@16
npm run postgres:local -- start
DATABASE_URL="postgresql://oa:oa_dev_password@127.0.0.1:55432/oa_commercial?schema=public" npm run db:deploy
DATABASE_URL="postgresql://oa:oa_dev_password@127.0.0.1:55432/oa_commercial?schema=public" RUN_DB_SEED=1 npm run db:seed
DATABASE_URL="postgresql://oa:oa_dev_password@127.0.0.1:55432/oa_commercial?schema=public" npm run dev:commercial
```

This is a project-local PostgreSQL cluster for development machines where Docker is not available. It still uses PostgreSQL and Prisma, writes `.local-postgres/.env.local-postgres` with API-required frontend flags, and keeps the cluster under `.local-postgres/`. It is not production evidence and does not close the Docker restore-drill gap; release still requires target-environment smoke, reviewed production secrets, signoffs, and backup/restore drill evidence.

`npm run doctor:commercial -- --json` selects database diagnostics in this order: explicit `DATABASE_URL` or `POSTGRES_*` environment variables, a running `npm run dev:commercial` manifest, `.local-postgres/.env.local-postgres`, then the default `127.0.0.1:5432`. This keeps old blocked dev manifests from hiding a working project-local PostgreSQL cluster on `55432`.

Docker-free local recovery drill:

```bash
ALLOW_LOCAL_RECOVERY_DRILL=1 \
DATABASE_URL="postgresql://oa:oa_dev_password@127.0.0.1:55432/oa_commercial_ci?schema=public" \
POSTGRES_DB=oa_commercial_ci \
POSTGRES_USER=oa \
POSTGRES_PASSWORD=oa_dev_password \
API_BASE_URL=http://127.0.0.1:8788 \
FILE_STORAGE_DRIVER=local \
FILE_STORAGE_DIR=.ci-files \
npm run drill:local-recovery

npm run validate:local-recovery-drill -- commercial-evidence/latest-local-recovery-drill-summary.json --json
```

This local drill uses `BACKUP_USE_LOCAL_PG_DUMP=1`, `BACKUP_USE_LOCAL_PG_RESTORE=1`, and `FILE_BACKUP_USE_LOCAL=1` internally, then writes a `commercial-local-recovery-drill` summary to `commercial-evidence/latest-local-recovery-drill-summary.json` with private file mode. Treat it as disposable local/staging diagnostic evidence only. It proves the app can round-trip a PostgreSQL backup plus local file-storage restore without Docker, but it does not replace the release `commercial-evidence/latest-drill-summary.json` evidence from `npm run drill:commercial`.

Production Compose template:

```bash
cp .env.production.example .env.production
# Fill POSTGRES_PASSWORD, JWT_SECRET, WEB_ORIGIN, and any approved bootstrap values.
npm run validate:production-env -- .env.production --json
docker compose --env-file .env.production -f docker-compose.prod.yml up --build -d
```

`docker-compose.prod.yml` runs with `APP_ENV=production`, `NODE_ENV=production`, `RUN_DB_SEED=0` by default, no host PostgreSQL port mapping, API-required frontend build args, and required Compose substitutions for `POSTGRES_PASSWORD`, `JWT_SECRET`, and `WEB_ORIGIN`. `Dockerfile.api` prepares `/app/storage/files`, assigns the application tree to the `node` user, and runs the API process as non-root; the production compose file also applies `no-new-privileges` and drops all Linux capabilities for the API service. Local-volume deployments should keep `FILE_STORAGE_DIR=/app/storage/files` unless the target host has explicitly prepared permissions for another absolute path. S3-compatible deployments may omit `FILE_STORAGE_DIR`; Compose still mounts an inert default local volume at `/app/storage/files` so the container shape stays stable while attachments and imported source artifacts go through the object-storage adapter. The production env file should be delivered through the deployment secret store; `.dockerignore` excludes `.env.*` files from Docker build context while preserving the checked-in example templates.

Production env file validation:

```bash
npm run validate:production-env -- .env.production --json
```

This validation rejects blank secrets, template domains, local origins including IPv4 and IPv6 loopback addresses, relative local-volume storage, unsafe backup directories, incomplete S3-compatible object storage settings, weak object-storage secrets, weak body-size settings, demo frontend fallback, weak bootstrap admin passwords, and unapproved production seeding before the container stack starts. The API runtime treats either `NODE_ENV=production` or `APP_ENV=production` as production mode, then repeats the highest-risk checks and refuses production boot with HTTP/local/template `WEB_ORIGIN`, temporary `FILE_STORAGE_DIR`, local/non-HTTPS object-storage endpoints, placeholder object-storage bucket/region/access-key values, short object-storage secret keys, or weak bootstrap admin passwords even if this pre-deploy command is skipped. It is intentionally stricter than `.env.production.example`: the template uses blank secrets and `https://oa.example.com` / `https://api.oa.example.com` as placeholders, while the real env file must use a deployment-managed PostgreSQL password, JWT secret, approved HTTPS origins, explicit absolute off-app `BACKUP_DIR`, a real Cloudflare account/token/tunnel/API-origin set when using Cloudflare, and either absolute backed `FILE_STORAGE_DIR` plus `FILE_BACKUP_DIR` with `FILE_STORAGE_DRIVER=local` or complete `OBJECT_STORAGE_*` values with `FILE_STORAGE_DRIVER=s3`. Always run before `docker compose -f docker-compose.prod.yml up`.

Production env preparation package:

```bash
npm run prepare:production-env -- --json
npm run prepare:production-env -- --storage-driver s3 --json
```

This writes a preparation package under `reports/commercial-evidence/production-env-prep/`, including `.env.production.template`, `secret-store-checklist.json`, `README.md`, and `manifest.json`. The template includes the durable backup fields `BACKUP_DIR` and, for local file storage, `FILE_BACKUP_DIR`. It also includes the Cloudflare backend handoff fields `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_TUNNEL_TOKEN`, `API_ORIGIN`, `CLOUDFLARE_DEPLOYMENT_URL`, and `CLOUDFLARE_BACKEND_WEB_ORIGIN`, so the same filled env file can drive `npm run validate:cloudflare-backend -- --env .env.production --json` and `npm run configure:cloudflare -- --env .env.production --repo 17602842555/HR --verify-token --json`. The optional `--verify-token` check calls Cloudflare's `/user/tokens/verify` endpoint and records only the active/failed status, never the token value or token id. No plaintext secret values are generated. The package directory is written with private `0700` permissions and package files with `0600` permissions. This is a preparation package only: copy the field list into the approved secret manager, fill the real `.env.production` through deployment tooling, run `npm run validate:production-env -- .env.production --json` and `npm run validate:cloudflare-backend -- --env .env.production --json`, then generate and validate reviewed signoffs. Treat the generated package as a checklist, not release evidence.

Cloudflare deployment status can inspect the backend Tunnel through Cloudflare's API when the account id and token are provided through the environment:

```bash
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<api-token-with-cloudflare-tunnel-read> \
npm run doctor:cloudflare -- --repo 17602842555/HR --tunnel <tunnel-uuid> --account-id <account-id> --api-origin <backend-origin> --url <worker-url> --json
```

Do not pass `CLOUDFLARE_API_TOKEN` as a CLI argument. The doctor redacts Cloudflare API failures and only reports tunnel id/name/status/config source, whether the Tunnel ingress maps `API_ORIGIN` to the expected backend service, and smoke-test blockers.

Production secrets signoff validation:

```bash
cp docs/production-secrets-signoff.example.json docs/production-secrets-signoff.json
# Replace example secret-store, origin, rotation, and reviewer fields, remove `example: true`, then run:
npm run validate:secrets-signoff -- docs/production-secrets-signoff.json --env .env.production --json
```

This validation rejects example signoffs, plaintext secret fields, stale `.env.production` SHA-256 values, failed production env validation, missing managed `POSTGRES_PASSWORD` / `JWT_SECRET` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_TUNNEL_TOKEN`, missing `DEFAULT_ADMIN_PASSWORD` management when production seeding is enabled, non-runtime secret injection, committed plaintext policy gaps, origin-policy mismatches against `WEB_ORIGIN`, weak rotation metadata, missing Security/Deployment approvals, and open production exceptions. Attach the passing JSON output and the reviewed signoff file to release evidence before closing GAP-003.

HR data signoff validation:

```bash
npm run prepare:hr-review -- --json
cp docs/hr-data-signoff.example.json docs/hr-data-signoff.json
# Replace example reviewers, confirm counts and policies, remove `example: true`, then run:
npm run validate:hr-signoff -- docs/hr-data-signoff.json --source oa-dashboard.html --json
```

`npm run prepare:hr-review -- --json` writes a reviewer package under `reports/commercial-evidence/hr-data-review/` with `people-review.csv`, `summary.json`, `README.md`, and `manifest.json`. The CSV contains no sensitive fields, masks names, records the current `oa-dashboard.html` checksum, and gives HR/Product a safe count-level packet to review. The package directory is private `0700` and files are private `0600`. It is not release evidence; after review, create the real non-example signoff and validate it.

This validation rejects example signoffs, stale `oa-dashboard.html` SHA-256 values, imported-count mismatches, missing HR/Product approvals, open production exceptions, sensitive export enablement, missing export ledger policy, and missing masked personnel fields. Attach the passing JSON output and the reviewed signoff file to release evidence before closing GAP-005.

File storage signoff validation:

```bash
cp docs/file-storage-signoff.example.json docs/file-storage-signoff.json
# Replace example storage provider, restore drill, audit event, and reviewer fields, remove `example: true`, then run:
npm run validate:storage-signoff -- docs/file-storage-signoff.json --file-storage-dir /app/storage/files --environment production --json
# For FILE_STORAGE_DRIVER=s3, omit --file-storage-dir and prove object-storage backup/restore in the signoff JSON.
```

This validation rejects example signoffs, local or ephemeral attachment paths, missing independent backup, weak RPO/RTO policy, missing restore drill evidence, failed restored-attachment download smoke, checksum mismatch, missing backup/restore audit event IDs, missing Infrastructure/Security approvals, and open production exceptions. Attach the passing JSON output and the reviewed signoff file to release evidence before closing GAP-004.

Signoff draft generation:

```bash
npm run signoff:drafts -- --json
npm run signoff:drafts -- --env .env.production --file-storage-dir /app/storage/files --json
```

This writes timestamped HR, production-secret, and file-storage draft files under `reports/commercial-evidence/signoff-drafts/` and refreshes `latest-manifest.json`. Draft directories are private `0700` and files are private `0600`, including rewritten latest manifests. The HR draft fills the current `oa-dashboard.html` SHA-256 and imported counts automatically. The secrets draft records only `.env.production` checksum, origin summary, and managed-secret names, never plaintext secret values. The storage draft carries the selected file storage driver plus local-volume path or object-storage shape, and the restore-drill fields that still need evidence. S3-compatible storage drafts include only non-secret object-storage metadata such as endpoint host, bucket, and region; they do not copy object-storage access keys or a fake local file-storage directory into the release review packet. These draft files are not release evidence; owners must copy reviewed non-draft versions into the approved evidence location, replace pending approvals, clear exceptions, and run the matching validators before GAP-003, GAP-004, or GAP-005 can close.

Commercial signoff validation workflow:

```bash
# Configure the staging or production GitHub environment with base64 secrets:
# PRODUCTION_ENV_B64
# PRODUCTION_SECRETS_SIGNOFF_B64
# HR_DATA_SIGNOFF_B64
# FILE_STORAGE_SIGNOFF_B64
# Then run: Actions -> commercial-signoff -> Run workflow.
```

`.github/workflows/commercial-signoff.yml` validates GAP-003, GAP-004, and GAP-005 inputs without committing secret-bearing files. The workflow uses Node 24-native GitHub actions and keeps `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` as a runner-level guard, then uses `npm run prepare:release-inputs -- --json --output reports/commercial-evidence/signoff-validation/release-inputs.json` to decode and validate every base64 GitHub environment secret before writing any release input file. Only after all decoded inputs pass shape validation does it materialize `.env.production`, `docs/production-secrets-signoff.json`, `docs/hr-data-signoff.json`, and `docs/file-storage-signoff.json` with private `0600` file permissions under private directories, then write a redacted private `0600` materialization manifest. Each validator step runs with `set -euo pipefail` and `umask 077`, so validator output files also inherit private permissions. The workflow now writes `cloudflare-backend.json` beside `production-env.json`, `secrets-signoff.json`, `hr-signoff.json`, and `storage-signoff.json`, so GAP-003 owner review covers both secret/origin signoff and the backend Tunnel/API origin path. The workflow uploads only `reports/commercial-evidence/signoff-validation` as `commercial-signoff-validation`; it does not upload `.env.production` or the materialized signoff files. This is validation evidence for owner review. Release acceptance still requires the full evidence package, Docker drill evidence, zero open GAP rows, and `npm run release:gate -- reports/commercial-evidence/latest.json --json`.

Local commercial development stack with port collision avoidance:

```bash
npm run dev:commercial
```

This first checks that the PostgreSQL target from `DATABASE_URL` or `POSTGRES_HOST` / `POSTGRES_PORT` is reachable. If PostgreSQL is closed, startup stops before spawning the API, writes a private `0600` `status=blocked` `reports/commercial-evidence/dev-stack.json` manifest without database secrets or local absolute paths, and prints the concrete next steps. After the database is reachable, it starts the Fastify API and Vite frontend together, automatically choosing free ports when `8787` or `5174` is already occupied. It writes a short-lived private `0600` `reports/commercial-evidence/dev-stack.json` manifest with redacted project paths, the selected API/Web ports, and the non-secret PostgreSQL host/port target, so the doctor can auto-detect the live commercial dev stack even from a separate terminal that does not have `DATABASE_URL` exported:

```bash
npm run doctor:commercial
```

Set `COMMERCIAL_DEV_MANIFEST` if the manifest should live somewhere else. Explicit `SERVER_PORT` / `WEB_PORT` still override the manifest for targeted diagnosis. Set `SKIP_COMMERCIAL_DEV_PREFLIGHT=1` only when the API can reach PostgreSQL through a network path that the host preflight cannot verify. The doctor checks Docker, optional local PostgreSQL tools, PostgreSQL reachability, live append-only database triggers, API identity, and whether the Vite `/api` proxy reaches this OA backend instead of another local service. It loads `.env` through `dotenv/config`. PostgreSQL reachability is checked against the actual `DATABASE_URL` host and port when present; otherwise it checks `POSTGRES_HOST` / `POSTGRES_PORT`, a running commercial dev manifest, `.local-postgres/.env.local-postgres`, and finally `127.0.0.1:5432`. When `DATABASE_URL` is available and PostgreSQL is reachable, `npm run doctor:commercial -- --json` queries the live database for the audit, export, and import append-only update/delete triggers. The command also returns a `readiness` block with `canRunDockerDrill`, `canReachPostgres`, `canVerifyDatabaseIntegrity`, `canRunApiSmoke`, `canRunFrontendApiSmoke`, hard blockers, warnings, next-step hints, and port-source details so release operators can distinguish code failures from local environment gaps. The commercial evidence target profile uses the same project-local dotenv fallback to mark local PostgreSQL as configured-but-local instead of unconfigured.

Commercial CI gate:

```bash
DATABASE_URL=postgresql://oa:oa_ci_password@127.0.0.1:5432/oa_commercial?schema=public npm run ci:commercial
```

`.github/workflows/commercial-ci.yml` runs this gate on pull requests and pushes to `main` with a PostgreSQL 16 service, using Node 24-native GitHub actions to avoid Node 20 deprecation warnings. The gate runs commercial preflight, offline supply-chain validation, SPDX SBOM generation, OpenAPI contract sync check, Prisma generation, `npm run db:deploy`, `npm run db:seed`, backend tests, production build, starts `node server/src/index.mjs`, waits for `/ready`, runs `npm run smoke:commercial`, then runs Playwright Chromium against the API-required Vite frontend. In API-required mode, the browser smoke logs in with the CI bootstrap account, asserts the UI is connected to the backend rather than local demo state, and submits a backend-backed expense workflow; the broad local-demo interaction tests are skipped in that mode because backend commercial smoke already verifies those server-side mutations. It creates `COMMERCIAL_EVIDENCE_DIR` by default with private directory permissions, writes `api.log`, `ready.json`, and `commercial-smoke.json` as private artifacts, and uploads `commercial-evidence`, Playwright reports, and test results as workflow artifacts. Set `RUN_E2E=0` only for a narrow backend-only diagnosis run; release candidates should keep it enabled.

Commercial Docker drill workflow:

```bash
# Run from GitHub Actions: Actions -> commercial-drill -> Run workflow.
# Optional input `run_release_evidence=true` also writes a diagnostic evidence package after the drill.
```

`.github/workflows/commercial-drill.yml` is a manual Docker-capable recovery drill for environments like GitHub-hosted Ubuntu runners where Docker Compose is available even if a local workstation does not have Docker. It uses Node 24-native GitHub actions, checks out the repo, installs dependencies, copies `.env.example` to `.env`, overrides file storage to the container volume path (`FILE_STORAGE_DIR="/app/storage/files"` and `FILE_BACKUP_USE_LOCAL="0"`), runs `npm run drill:commercial`, validates `commercial-evidence/latest-drill-summary.json` with `npm run validate:drill-evidence -- commercial-evidence/latest-drill-summary.json --json`, always tears down the compose stack with `docker compose down -v --remove-orphans`, and uploads `commercial-evidence`, `backups`, and `reports/commercial-evidence` as `commercial-drill-evidence`. Run `26677304350` passed on 2026-05-30 and uploaded artifact `7306216857`; the downloaded artifact also revalidates locally because the validator can replay GitHub runner artifact paths. This workflow mitigates the local Docker CLI blocker, but it is still local-demo drill evidence unless production/staging `.env.production`, signoffs, and release-gate evidence are also green.

Migration integrity validation is deterministic and does not require a database:

```bash
npm run validate:migrations -- --json
npm run migrations:lock -- --json
```

The committed `prisma/migrations/migration-lock.json` pins every historical `migration.sql` path, byte size, statement count, and SHA-256. `npm run validate:migrations -- --json` must pass before commercial CI, release evidence, and any production `db:deploy`. Run `npm run migrations:lock -- --json` only after intentionally adding or reviewing a migration; do not use it to overwrite unexpected drift.

Supply-chain validation is deterministic and does not require registry access:

```bash
npm run validate:supply-chain -- --json
```

It checks `package-lock.json` lockfile version, declared dependency coverage, package integrity hashes, HTTPS npm registry sources, and an approved permissive-license allow-list before the commercial CI or release evidence can pass.

SBOM generation is offline from the committed lockfile and does not require registry access:

```bash
npm run sbom:generate -- --check --json
npm run sbom:generate -- --json
```

The check mode validates that an SPDX 2.3 document can be generated without writing files. Its JSON summary includes a stable source hash that ignores the generated timestamp plus the exact document hash. The release evidence mode writes `reports/commercial-evidence/sbom/latest-spdx.json` with private `0600` mode and records the artifact checksum in the evidence package.

Commercial evidence package:

```bash
npm run evidence:commercial
EVIDENCE_RUN_E2E=1 npm run evidence:commercial -- --e2e
npm run evidence:commercial -- --strict-readiness
npm run audit:evidence-permissions -- --json
npm run validate:drill-evidence -- commercial-evidence/latest-drill-summary.json --json
```

The evidence script writes timestamped JSON plus `reports/commercial-evidence/latest.json` with private `0600` file mode and records `evidenceMode` as `full`, `quick`, or `partial`. It runs commercial preflight, migration lock validation, supply-chain validation, SPDX SBOM generation, brand check, OpenAPI contract sync, HR review preparation, production env validation, Cloudflare backend validation, secrets signoff validation, HR data signoff validation, File storage signoff validation, commercial drill evidence validation, local recovery evidence validation, Prisma generation, backend tests, Vite build, and doctor diagnostics, then records command outputs, exit codes, durations, artifact checksums, migration names, the migration lock checksum, the SBOM `latest-spdx.json` checksum, the HR review `latest-manifest.json` checksum, and `docs/KNOWN_GAPS.md` rows. The summary includes `releaseCandidateReady`, `releaseBlockers`, and `e2eIncluded`, so a green local evidence command still explains why it is not production release evidence when E2E, signoffs, Docker drill, Target Profile, or gap closure are missing. After the evidence JSON is written, it also runs `npm run gap:report` against that exact evidence file, refreshes `reports/commercial-evidence/latest-gap-report.json` and `latest-gap-report.md`, runs `npm run audit:evidence-permissions -- --json` to prove latest evidence, migration lock, SBOM, HR review, preparation, signoff draft, and owner handoff artifacts are private, and rewrites the evidence artifact inventory so the report checksum is archived with the same run. Archived evidence redacts the project root, database URL passwords, and password/secret/token/key environment values from command output and parsed JSON. Command capture uses a large default output buffer so backend TAP output is not misclassified as a failed check; set `COMMERCIAL_EVIDENCE_MAX_BUFFER_BYTES` only if a CI runner needs a different capture limit. Spawn-level command errors are copied into archived stderr so `ENOENT` or buffer failures stay visible in release evidence. HR review preparation is a required evidence check because reviewers need a reproducible packet before final signoff; production env, cloudflare-backend, secrets signoff, doctor, HR signoff, storage signoff, and `drill-evidence` failures are captured as release-blocking warning checks without hiding the passing static gates. `local-recovery-evidence` is archived as a diagnostic check only, so it documents Docker-free recovery health but never replaces the release `drill-evidence` gate. Use `--quick` only for local diagnostics; release candidates must use `full` evidence. Use `--strict-readiness` in staging or CI when Docker, PostgreSQL, API, and frontend proxy readiness must all be green before accepting the package.

Commercial release gate:

```bash
npm run candidate:commercial -- --json
EVIDENCE_RUN_E2E=1 npm run evidence:commercial -- --e2e --strict-readiness
npm run audit:readiness -- reports/commercial-evidence/latest.json --json
npm run dossier:commercial -- reports/commercial-evidence/latest.json --json
npm run release:gate -- reports/commercial-evidence/latest.json --json
```

`npm run candidate:commercial -- --json` is the one-command release-candidate wrapper: it runs the evidence package with E2E and strict readiness, runs the readiness audit, writes the release dossier, and then runs the release gate. It writes `reports/commercial-evidence/latest-candidate.json` for handoff with private `0600` file mode and makes a fresh candidate output directory private `0700`. The candidate wrapper redacts project paths and secret-like environment values from archived step output, records spawn-level command errors, and uses a large command output buffer; set `COMMERCIAL_RELEASE_CANDIDATE_MAX_BUFFER_BYTES` only when a CI runner needs a different limit. `npm run candidate:commercial -- --diagnostic --json` is intentionally non-accepting: it reports `diagnosticOnly`, exits nonzero, and cannot be used as release evidence. The release dossier writes `reports/commercial-evidence/latest-dossier.md` with private `0600` file mode and makes a fresh dossier output directory private `0700`, summarizing the evidence checks, GAP closure audit, doctor readiness, artifact snapshot, Target Profile classification, and next actions for handoff; it redacts the project root, secret-like command flags, database host/name, and API endpoint values before writing markdown. A dossier generated with `--allow-missing-e2e` is marked `DIAGNOSTIC_ONLY` and is not release acceptance evidence. The release gate reads a generated evidence report and requires `evidenceMode=full`, migration integrity evidence, supply-chain evidence, SBOM evidence, evidence permission audit evidence, E2E evidence, HR review preparation evidence, production env evidence, Cloudflare backend evidence, secrets signoff evidence, HR data signoff evidence, File storage signoff evidence, commercial drill evidence, readiness audit, zero open gaps, green doctor readiness, and evidence generated within the accepted evidence freshness window. It also requires `targetProfile.evidenceClass=production-release-evidence`, production runtime, production evidence ready, `VITE_REQUIRE_API=1`, `VITE_DEMO_FALLBACK=0`, and a configured non-local PostgreSQL target. The release gate CLI summarizes Target Profile database evidence as local/non-local/unconfigured and does not echo database host, name, or URL into handoff JSON. By default, `release:gate` accepts evidence generated within 24 hours; use `--max-evidence-age-hours <hours>` only when the release manager deliberately tightens or extends that window. The readiness audit maps GAP-001 through GAP-005 to the required command evidence and doctor readiness flags, so a gap cannot be closed or deleted in `docs/KNOWN_GAPS.md` until the matching evidence is green. It also fails when any required check fails, when any warning check such as `production-env`, `cloudflare-backend`, `secrets-signoff`, `hr-signoff`, `storage-signoff`, `drill-evidence`, or `doctor` is nonzero, when the evidence is stale or future-dated, when the evidence mode is quick/partial/missing, when the Target Profile is local/CI/demo evidence, or when `docs/KNOWN_GAPS.md` still has `Open` rows. Use `npm run release:gate -- reports/commercial-evidence/latest.json --allow-missing-e2e --json` only for a narrow diagnostic review, never for a release candidate.

Commercial gap action report:

```bash
npm run gap:report -- --json
npm run gap:report -- reports/commercial-evidence/latest.json --json
```

This writes `reports/commercial-evidence/latest-gap-report.json`, `reports/commercial-evidence/latest-gap-report.md`, `reports/commercial-evidence/latest-owner-handoff-manifest.json`, and `reports/commercial-evidence/latest-owner-handoff.md` with private `0600` file mode. It also creates timestamped per-owner Markdown handoff files under `reports/commercial-evidence/commercial-owner-handoff-*/`. The report groups open or blocked GAP rows by owner, lists the next validation commands, carries the redacted Target Profile classification, summarizes required/warning check failures, redacts local evidence paths, and gives Deployment/Security/HR/Infrastructure teams a compact handoff from the latest evidence package. It is an action handoff only, not release evidence and not a release gate substitute; release acceptance still requires `npm run candidate:commercial -- --json` and `npm run release:gate -- reports/commercial-evidence/latest.json --json` to pass without diagnostic flags.

Authenticated administrators can also see a safe owner summary from the latest gap report and a safe latest-commercial-evidence summary in `/api/system/readiness` and the audit-page 商用发布状态 panel. That runtime summary exposes only owner names, GAP IDs, target dates, blocker counts, validation-command counts, check IDs, exit codes, Target Profile classification, local/non-local PostgreSQL classification, and non-release-evidence status; it does not return report file paths, validation commands, blocker text, evidence paths, database URLs, database names, hostnames, command output, or filesystem paths.

Full commercial acceptance and recovery drill:

```bash
cp .env.example .env
npm run drill:commercial
```

The drill first runs the static commercial gates (`preflight:commercial`, `brand:check`, and `contract:api`) before touching Docker or the database. It then runs `docker compose up --build -d`, waits for `/ready`, executes the commercial smoke test, creates an audited backup, restores the latest backup, reapplies migrations, waits for readiness again, and runs the smoke test a second time. It writes `pre-restore-ready.json`, `pre-restore-smoke.json`, `post-restore-ready.json`, `post-restore-smoke.json`, and `drill-summary.json` under a private `COMMERCIAL_EVIDENCE_DIR`, then refreshes `commercial-evidence/latest-drill-summary.json` with private file mode; the summary masks the database password before it is printed or archived and stores project-local relative paths where possible so downloaded artifacts can be revalidated. Validate the archived drill with `npm run validate:drill-evidence -- commercial-evidence/latest-drill-summary.json --json` so backup metadata, checksums, tar entry safety, backup freshness against RPO, total drill duration against RTO, pre/post readiness, and pre/post smoke are proven before release. It is destructive to the target database. It refuses to run with `APP_ENV=production` unless `ALLOW_PRODUCTION_DRILL=1` is set after incident approval.

When Docker is unavailable on a development machine, run `npm run drill:local-recovery` against a disposable local PostgreSQL database and validate it with `npm run validate:local-recovery-drill`. That produces `commercial-evidence/latest-local-recovery-drill-summary.json` for engineering diagnosis only; the release gate and GAP-002 still require Docker compose drill evidence through `npm run drill:commercial` or the manual `commercial-drill` workflow.

The compose stack starts:

- `postgres`: PostgreSQL 16 with a persistent `postgres-data` volume.
- `api`: Fastify API, `prisma migrate deploy`, optional bootstrap seed when `RUN_DB_SEED=1`, then `node server/src/index.mjs`.
- `web`: nginx static frontend on `http://127.0.0.1:8080`, proxying `/api` to the API service.
- `file-storage`: persistent local attachment volume mounted at `FILE_STORAGE_DIR` when `FILE_STORAGE_DRIVER=local`; when `FILE_STORAGE_DRIVER=s3`, Compose defaults the mount target to `/app/storage/files` if `FILE_STORAGE_DIR` is unset, but attachments and imported source artifacts are stored through the object-storage adapter.

API container health uses `/ready`, which verifies the Fastify process, PostgreSQL connectivity, live append-only database triggers for audit/export/import ledgers, and file-storage readiness. `/health` remains a lightweight process liveness endpoint.

For production, set `RUN_DB_SEED=0` unless the reviewed bootstrap seed is intentionally part of the cutover. If a production bootstrap seed is explicitly approved, set both `RUN_DB_SEED=1` and `ALLOW_PRODUCTION_SEED=1`, provide a non-default `DEFAULT_ADMIN_PASSWORD` that satisfies the password policy, and configure either `FILE_STORAGE_DIR` on the approved absolute persistent-volume path or complete `OBJECT_STORAGE_*` settings for `FILE_STORAGE_DRIVER=s3`. The seed script refuses production seeding without that approval, rejects temporary local file-storage paths plus non-HTTPS or template object-storage endpoints before opening Prisma, and no longer prints the bootstrap password.

Runtime validation refuses to boot when:

- In production, `JWT_SECRET` is missing, shorter than 32 characters, or contains placeholder text such as `changeme`, `example`, `placeholder`, `replace-with`, or `todo`.
- `COOKIE_MAX_AGE_SECONDS` is not a positive integer.
- `AUTH_FAILED_LOGIN_LIMIT`, `AUTH_FAILED_LOGIN_WINDOW_MS`, or `AUTH_FAILED_LOGIN_MAX_KEYS` is not a positive integer.
- `FILE_MAX_UPLOAD_BYTES`, `IMPORT_MAX_HTML_BYTES`, or `API_BODY_LIMIT_BYTES` is not a positive integer.
- `API_BODY_LIMIT_BYTES` is lower than the configured dashboard-import body size or base64 attachment upload envelope, because Fastify must not reject valid business requests before route-level validation and audit logging run.
- In production with `FILE_STORAGE_DRIVER=local`, `FILE_STORAGE_DIR` is missing, implicit, or relative. It must point to an explicit absolute backed persistent volume path.
- In production with `FILE_STORAGE_DRIVER=s3`, any required `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ACCESS_KEY_ID`, or `OBJECT_STORAGE_SECRET_ACCESS_KEY` value is missing, local/example, or placeholder.
- In production, `WEB_ORIGIN=*`.
- In production, `RUN_DB_SEED=1` and `DEFAULT_ADMIN_PASSWORD` is missing, shorter than 12 characters, lacks letters or digits, or contains default/placeholder text such as `admin123456`, `changeme`, `example`, `placeholder`, `replace-with`, or `todo`.
- In production, `scripts/seed.mjs` is run without `ALLOW_PRODUCTION_SEED=1`, without a non-default policy-compliant admin password, or without approved local/S3 file-storage settings.

Login protection:

- Login sets an `HttpOnly`, `SameSite=Lax`, explicit `Max-Age` session cookie.
- Production login cookies are also `Secure`.
- Logout increments `sessionVersion` and clears the cookie with the same hardened attributes.
- Failed login responses stay generic as `invalid_credentials`.
- `AUTH_FAILED_LOGIN_LIMIT` and `AUTH_FAILED_LOGIN_WINDOW_MS` control the short-window login attempt limit.
- `AUTH_FAILED_LOGIN_MAX_KEYS` caps the in-memory failure bucket count and evicts expired or oldest buckets under account-spraying load.
- When the limit is reached, `/api/auth/login` returns `429 too_many_login_attempts` with `Retry-After`.
- Valid-tenant failed and blocked logins are written to append-only audit logs.

Cross-site request protection:

- Mutating methods `POST`, `PUT`, `PATCH`, and `DELETE` reject browser requests whose `Origin` or `Referer` does not match `WEB_ORIGIN` or the API host.
- `X-Forwarded-Host` and `X-Forwarded-Proto` are ignored by default. Set `TRUST_PROXY=1` only when the API is reachable exclusively through a trusted reverse proxy that strips or rewrites client-supplied forwarded headers.
- Safe methods `GET`, `HEAD`, and `OPTIONS` are not blocked by this guard.
- CLI, smoke, backup, and server-side automation requests without browser origin headers remain allowed and still rely on JWT/IAM checks.

API responses include `X-Request-Id` for support traceability, browser hardening headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Resource-Policy`, `X-Permitted-Cross-Domain-Policies`), and `Cache-Control: no-store` for `/api/*`. Production API responses additionally include HSTS. Audit rows created through API requests include the request id in metadata so operators can connect browser-visible failures to append-only audit rows.

`API_BODY_LIMIT_BYTES` must stay at least as large as the configured file upload and dashboard HTML import limits. The nginx `client_max_body_size` in `docker/nginx.conf` must also stay above that API body limit; the Docker web proxy is set to `11m` so 5 MB attachments and 10 MB dashboard HTML imports reach route-level validation. Rejected oversized, empty, or high-risk payloads should produce auditable business errors instead of proxy/framework-level disconnects.

List endpoints clamp `limit` query parameters before calling Prisma. Audit, attendance, finance, import, and attachment lists must use bounded defaults when a browser or script sends missing, invalid, negative, or excessive limits.

Production frontend builds should set `VITE_REQUIRE_API=1` and keep `VITE_DEMO_FALLBACK=0`. `Dockerfile.web` defaults to these values and `docker-compose.yml` passes them as web build args, so the nginx image is built as an API-required frontend by default. If the API is unavailable, the frontend must show the backend-unavailable screen rather than loading local demo personnel, approval, payroll, or audit data. API-required builds also skip persisted local demo state and remove stale `oa-enterprise-system-v1` browser storage instead of reading it. In demo builds, write-action fallback is limited to network timeout/unreachable API errors; API business errors such as `403`, `409`, or `422` remain API failures and must not mutate local state. Use `VITE_DEMO_FALLBACK=1` only for explicitly labelled demo builds.

## Cloudflare Worker Deployment

The repository includes `wrangler.toml`, `cloudflare/worker.js`, and `.github/workflows/cloudflare-deploy.yml` so the frontend can be pushed to `17602842555/HR.git` and deployed as Cloudflare Worker static assets. The Worker serves the Vite `dist/` SPA and proxies `/api/*` to the configured backend origin through `API_ORIGIN`, while `/api/edge/health` verifies the edge gateway itself. `wrangler.toml` declares `API_ORIGIN` under `[secrets].required`, so Wrangler deploys fail before publication if the Worker secret is not configured. The Worker also validates `API_ORIGIN` at runtime and fails closed for missing values, non-HTTPS origins, local/private addresses, or same-origin proxy loops, so a manual Secret mistake cannot silently proxy production traffic to an unsafe backend.

Current Cloudflare setup created on 2026-05-30:

- Worker deployed: `deep-oa-hr` at `https://deep-oa-hr.2445776963.workers.dev`, version `9ef44b70-abd0-4d3b-a9d7-b63791120478`.
- Edge health passes at `/api/edge/health`; `/api/*` correctly returns `api_origin_not_configured` until `API_ORIGIN` is set to the approved backend Tunnel hostname. Runtime health reports `apiOriginValid=false` without leaking the configured hostname when the Worker rejects an unsafe origin.
- GitHub repository secrets currently configured: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DEPLOYMENT_URL`, `CLOUDFLARE_BACKEND_WEB_ORIGIN`, and `CLOUDFLARE_TUNNEL_TOKEN`.
- Still required for GitHub auto-deploy and production release: durable `CLOUDFLARE_API_TOKEN`, production `API_ORIGIN`, production `.env.production`, production database/file-storage signoffs, and Cloudflare smoke through the final backend origin.

Check the current Cloudflare deployment state without printing secret values:

```bash
npm run doctor:cloudflare -- \
  --repo 17602842555/HR \
  --tunnel 399ce110-a343-43b5-81cd-333f5f86212c \
  --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --api-origin "$API_ORIGIN" \
  --url https://deep-oa-hr.2445776963.workers.dev \
  --json
```

This status command fails closed until required repository secrets are present, the Tunnel is active/healthy, the remotely-managed Tunnel configuration maps the `API_ORIGIN` hostname to `http://api:8787` and ends with a final `http_status:404` catch-all rule, the Worker reports a configured and valid API origin, and `npm run smoke:cloudflare` can prove both `/api/edge/health` and the backend `/api/health` / `/api/openapi.json` path through the Worker.

Required GitHub repository secrets:

```bash
CLOUDFLARE_API_TOKEN=<Cloudflare token with Workers deploy permission>
CLOUDFLARE_ACCOUNT_ID=<Cloudflare account id>
API_ORIGIN=https://<approved-api-origin>
CLOUDFLARE_DEPLOYMENT_URL=https://<worker-or-custom-domain>
CLOUDFLARE_TUNNEL_TOKEN=<remotely-managed tunnel token for backend API>
CLOUDFLARE_BACKEND_WEB_ORIGIN=https://<worker-or-custom-domain> # optional override, defaults to deployment URL
```

Prepare and validate those repository secrets without printing secret values:

```bash
# Keep CLOUDFLARE_API_TOKEN outside the checked-in env file when possible.
CLOUDFLARE_API_TOKEN=<Cloudflare token with Workers deploy permission> \
CLOUDFLARE_ACCOUNT_ID=<32-character account id> \
npm run configure:cloudflare -- --env .env.production --repo 17602842555/HR --verify-token --json

# Apply only after the token-verified dry-run JSON is ok=true.
CLOUDFLARE_API_TOKEN=<Cloudflare token with Workers deploy permission> \
CLOUDFLARE_ACCOUNT_ID=<32-character account id> \
npm run configure:cloudflare -- --env .env.production --repo 17602842555/HR --verify-token --apply
```

`configure:cloudflare` validates the backend tunnel origin, frontend deployment origin, tunnel token, Cloudflare account id, and deploy token before it writes anything. With `--verify-token`, it calls Cloudflare's token verification API and fails closed unless the token status is active. When `--apply` is used it calls `gh secret set` with each value over stdin, so token material is not placed in shell arguments or command logs.

The GitHub Actions workflow uses Node 24-native GitHub and Cloudflare actions, writes `API_ORIGIN` into a temporary private `.cloudflare-worker-secrets.env` file, deploys the Worker with `wrangler deploy --secrets-file .cloudflare-worker-secrets.env`, validates the backend Tunnel/server environment with a temporary private env file when `CLOUDFLARE_TUNNEL_TOKEN` is present, removes the temporary Worker secrets file, and runs `npm run smoke:cloudflare` against `CLOUDFLARE_DEPLOYMENT_URL` when that URL is present. Push-triggered runs remain build-only when Cloudflare secrets are missing, but manual `workflow_dispatch` runs default to `require_deploy=true` and fail if `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `API_ORIGIN`, `CLOUDFLARE_DEPLOYMENT_URL`, or `CLOUDFLARE_TUNNEL_TOKEN` are not configured. Use `require_deploy=false` only for an intentional build-only dry run. The smoke check verifies `/api/edge/health`, backend `/api/health`, and the backend OpenAPI contract through the Cloudflare gateway. For local deployment, use the same required Cloudflare Worker runtime secret:

```bash
API_ORIGIN=https://<approved-api-origin>
```

Local deployment commands:

```bash
npm run build
umask 077
printf 'API_ORIGIN="%s"\n' "$API_ORIGIN" > .cloudflare-worker-secrets.env
npx wrangler deploy --secrets-file .cloudflare-worker-secrets.env
rm -f .cloudflare-worker-secrets.env
npm run smoke:cloudflare -- --url https://<worker-or-custom-domain> --json
```

## Cloudflare Tunnel Backend Server

Use `docker-compose.cloudflare.yml` together with `docker-compose.prod.yml` when the Fastify API should be exposed through Cloudflare without opening an inbound API port on the server. The `cloudflared` sidecar is outbound-only, waits for the API healthcheck, runs with `no-new-privileges`, and drops all Linux capabilities. Create a remotely-managed Cloudflare Tunnel, set its public hostname to the backend API domain, and route that hostname to the compose service URL:

```text
http://api:8787
```

Current Tunnel created on 2026-05-30: `deep-oa-hr-api` (`399ce110-a343-43b5-81cd-333f5f86212c`). It is inactive until a server runs `cloudflared` with the repository `CLOUDFLARE_TUNNEL_TOKEN` and the Tunnel has a public hostname in Cloudflare. The current Cloudflare account has no DNS zone, so add a domain to Cloudflare or provide another approved HTTPS API hostname before setting `API_ORIGIN`.

Required server-side production values:

```bash
CLOUDFLARE_TUNNEL_TOKEN=<remotely-managed tunnel token>
API_ORIGIN=https://api.<your-domain>
CLOUDFLARE_DEPLOYMENT_URL=https://<worker-or-custom-domain>
WEB_ORIGIN=https://<worker-or-custom-domain>
TRUST_PROXY=1
```

Validate the backend Cloudflare env before starting the production stack:

```bash
npm run validate:production-env -- .env.production --json
npm run validate:cloudflare-backend -- --env .env.production --json
```

The Cloudflare backend validator fails closed for missing or placeholder remotely-managed Tunnel tokens, non-HTTPS or local origins, Worker/API same-origin loops, wildcard web origins, `example.com` template hosts in `API_ORIGIN`, `CLOUDFLARE_DEPLOYMENT_URL`, or `WEB_ORIGIN`, and unapproved or weak production bootstrap seed credentials when `RUN_DB_SEED=1`.

Start the backend server with the tunnel sidecar:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.cloudflare.yml --env-file .env.production up -d --build postgres api cloudflared
```

After the tunnel reports healthy, deploy or redeploy the Worker with the required API-origin secret and smoke the public gateway:

```bash
umask 077
printf 'API_ORIGIN="%s"\n' "$API_ORIGIN" > .cloudflare-worker-secrets.env
npx wrangler deploy --secrets-file .cloudflare-worker-secrets.env
rm -f .cloudflare-worker-secrets.env
npm run smoke:cloudflare -- --url "$CLOUDFLARE_DEPLOYMENT_URL" --json
```

`API_ORIGIN` must be the backend tunnel hostname. Do not set it to the same origin as `CLOUDFLARE_DEPLOYMENT_URL`; that would make the Worker proxy `/api/*` back into itself. The runtime guard rejects that loop, rejects `http://`, localhost, loopback, RFC1918, link-local, and `.local` targets, and returns a redacted `503` response instead of attempting the backend fetch.

Keep the existing Fastify/Prisma/PostgreSQL API as the commercial system of record unless the data layer is explicitly ported to Cloudflare D1/Hyperdrive/R2. The Worker is the Cloudflare edge backend/gateway: it adds security headers, hosts the frontend assets, and keeps browser traffic same-origin at `/api/*`. Production release evidence still requires the API origin, database, file storage, signoffs, and backup/restore drill to pass the commercial gate.

Optional local-tool mode:

```bash
DATABASE_URL=postgres://postgres:change-me@127.0.0.1:5432/oa
BACKUP_USE_LOCAL_PG_DUMP=1
BACKUP_USE_LOCAL_PG_RESTORE=1
```

## Pre-Deploy Checklist

1. Confirm no Feishu name, logo, trademark, screenshots, proprietary copy, or protected visual assets are present in the deployable build.
2. Run `npm run brand:check` so the automated deployable-source brand boundary gate scans frontend, backend, runtime config templates, Docker deploy files, Prisma schema, and public assets.
3. Confirm production secrets are not committed and `.env` is delivered through the deployment platform or server secret store.
4. Run `npm install` on the target Node version.
5. Run `npm run build`.
6. Run `npm run validate:migrations -- --json` and confirm `prisma/migrations/migration-lock.json` matches the reviewed migration SQL before any production schema change.
7. Run backend migrations in the approved environment with `npm run db:deploy` for production or `npm run db:migrate` for local development.
8. Run `npm run backup:postgres` before migration or first production cutover.
9. Run `npm run backup:files` whenever the current local-volume deployment has uploaded attachments or imported source files on `FILE_STORAGE_DIR`; for `FILE_STORAGE_DRIVER=s3`, run the approved bucket replication/export procedure and attach that evidence to the storage signoff.
10. Run `npm run db:seed` only for demo or first non-production bootstrap data. Production seed must be reviewed before execution.
11. Run smoke checks for app load, login/session, approval countersign/transfer, audit log, backend CSV export audit with required business reason, and sensitive-field masking.

## Commercial Smoke

After a database-backed API is running, execute:

```bash
API_BASE_URL=http://127.0.0.1:8787 npm run smoke:commercial
```

Set `COMMERCIAL_EVIDENCE_DIR=./commercial-evidence/manual-smoke` or `COMMERCIAL_SMOKE_EVIDENCE_FILE=./commercial-evidence/manual-smoke.json` to archive the smoke result. The script writes a structured JSON payload with `kind`, `runId`, timestamps, base URL, tenant code, and per-module evidence on success; when a check fails it writes a failure payload with partial evidence and the error details.

The smoke script logs in with the configured admin account and verifies:

- API health, DB readiness, and `/api/auth/me`.
- Login/session flow, logout token revocation, IAM role assignment, employee-account library sync, and backend failed-login audit/rate-limit tests covered by `npm run test:server`.
- Imported people counts from `oa-dashboard.html`.
- Dashboard import lineage through `/api/imports`, including source checksum, imported row counts, checksum-verified original source artifact download through `/api/imports/:id/source` without exposing storage keys, configured HTML size limit through `IMPORT_MAX_HTML_BYTES`, aligned API body limit through `API_BODY_LIMIT_BYTES`, empty-import denial audit, and duplicate-import protection for repeated successful source name plus checksum pairs through both API checks and a PostgreSQL partial unique index.
- Management analytics through `/api/analytics/overview` and `/api/analytics/export`, including imported people totals, department distribution, approval efficiency, asset status, administrative cost, risk approval rows, CSV headers, row-count headers, required business reason, and `analytics.export` audit coverage.
- Employee maintenance for controlled HR fields through `/api/people/employees/:id`, including persisted role update, default sensitive-field masking, `employee.update` audit coverage, sensitive reveal `403` denial without permission, and successful reveal audit coverage.
- Attendance leave creation with workflow linkage, payroll batch creation with workflow linkage and idempotent retry, payroll publish blocked before full workflow approval, payroll review/publish after approved workflow linkage, and archived-payroll rejection.
- HR lifecycle approval definitions through `/api/approvals/definitions`, including onboarding, regularization, transfer, offboarding, abnormal personnel reports, recruitment, salary adjustment, transfer workflow creation, and approved lifecycle workflows that update employee profiles plus `employee.lifecycle.*` audit evidence while keeping salary/action-plan metadata out of ordinary people summaries.
- Approval rule create/preview/coverage/disable/delete, disabled-rule fallback to workflow definitions for new submissions, backend department-by-workflow coverage rows with approver binding gaps, workflow submission idempotency for approval and leave creation, approval withdraw applicant/admin guard, approver identity guard, transactional approval `FOR UPDATE` lock coverage, post-lock idempotency replay guard, approval transfer replacement task, and one end-to-end expense approval to final approval.
- Authenticated actor propagation for approval comments, leave workflow applicants, payroll reviewers, resource booking applicants, asset lifecycle operators, and audit actor display; client-supplied asset operator identity is ignored.
- Asset creation, borrow, duplicate-borrow transition rejection, inventory, return, repair, and QR replacement.
- Resource booking with conflict-safe slot selection, followed by a duplicate booking check that must return `409` and write a failed `resource.booking.conflict` audit row.
- File attachment upload/list/download from the frontend attachment center with storage-key hiding, upload/download audit rows, and high-risk HTML/SVG/script attachment rejection with failed audit rows.
- Backend-generated CSV audit export with browser download, `Content-Disposition`, `X-Row-Count`, exported body, required business reason, export audit row creation, and bounded tenant-scoped audit list queries with object/time/result filters.

This script is intentionally stateful and writes smoke rows. Run it against demo, staging, or a production-like validation tenant, not an unapproved live production tenant.

## Backup

Default Docker Compose backup:

```bash
POSTGRES_SERVICE=postgres POSTGRES_USER=oa POSTGRES_DB=oa_commercial npm run backup:postgres
```

By default the backup script attempts to record an `ops.backup` row in `audit_logs` after the dump is written. Ops audit rows are written through the backend `appendAuditLog` path, so sidecar metadata follows the same sensitive-field redaction policy as API audit rows. Set `OPS_AUDIT_REQUIRED=1` in staging/production so a missing audit row fails the run. Use `SKIP_OPS_AUDIT=1` only for pre-migration bootstrap backups where the audit schema does not exist yet.

Local `pg_dump` backup:

```bash
DATABASE_URL=postgres://postgres:change-me@127.0.0.1:5432/oa \
BACKUP_USE_LOCAL_PG_DUMP=1 \
npm run backup:postgres
```

File storage backup:

```bash
npm run backup:files
```

The tar-based file backup script is only for `FILE_STORAGE_DRIVER=local` deployments backed by a durable volume. It will fail closed for S3 object storage; use the bucket provider's replication/export process, then attach that evidence to the file-storage signoff.

For a non-Docker local directory backup:

```bash
FILE_BACKUP_USE_LOCAL=1 FILE_STORAGE_DIR=./.local-files npm run backup:files
```

Backup acceptance:

- Backup exits with code 0.
- `.dump` file and `.meta` file are written under `BACKUP_DIR`.
- `.meta` includes database name, environment, timestamp, byte size, and SHA-256 checksum.
- Backup file permissions are private to the operator account.
- File backup writes `.tar.gz` and `.meta` files under `FILE_BACKUP_DIR`, includes `artifact_type=file_storage`, file count, byte size, and SHA-256 checksum, and records `ops.backup` as `ops_file_storage` through the unified audit redaction path when the audit schema exists.
- Production database and file-storage backup output directories require explicit absolute off-app durable paths. `npm run backup:postgres`, `npm run backup:files`, and production apply-mode pruning reject implicit defaults, project-local paths, `/tmp`, and `/var/tmp`.

Attachment backup acceptance:

- `FILE_STORAGE_DIR` is on a persistent volume when using `FILE_STORAGE_DRIVER=local`, or `FILE_STORAGE_DRIVER=s3` points at the approved private object-storage bucket.
- `npm run backup:files` or equivalent object-store replication/export is run with the database backup when audit rows or approval forms reference uploaded files.
- Production local-volume file backup and restore require an explicit absolute FILE_STORAGE_DIR; the scripts must not fall back to `.local-files`, `/tmp`, `/var/tmp`, or an implicit container default.
- Restore verification includes downloading at least one uploaded attachment by file id.

## Backup Retention

Run retention pruning after a successful backup and after the backup artifacts have been copied to durable storage:

```bash
npm run prune:backups
```

The default mode is dry-run and does not delete anything. Apply retention explicitly:

```bash
PRUNE_APPLY=1 PRUNE_DATABASE_KEEP=14 PRUNE_FILE_KEEP=14 npm run prune:backups
```

Production pruning requires an extra guard:

```bash
APP_ENV=production ALLOW_PRODUCTION_PRUNE=1 PRUNE_APPLY=1 npm run prune:backups
```

Retention acceptance:

- Dry-run prints the database and file-storage backup artifacts that would be deleted.
- Apply mode deletes stale `.dump` / `.tar.gz` artifacts and their `.meta` sidecars.
- Apply mode records `ops.backup_prune` as `ops_backup_retention` through the unified audit redaction path when audit schema access is available.
- Keep counts must be positive integers and should satisfy the current retention policy. The default local run keeps the 14 newest database backups and 14 newest file-storage backups.
- Production apply-mode pruning requires explicit absolute off-app `BACKUP_DIR` and `FILE_BACKUP_DIR` values so retention cleanup cannot accidentally delete project-local or temporary artifacts.

## Restore

Restore is destructive. It cleans existing database objects before replaying the dump. Run it only against a fresh database, a recovery database, or after an incident lead approves the restore.

Default Docker Compose restore:

```bash
npm run restore:postgres -- ./backups/postgres/oa-20260529-203000.dump --yes
```

Production restore requires an extra guard:

```bash
APP_ENV=production ALLOW_PRODUCTION_RESTORE=1 \
npm run restore:postgres -- ./backups/postgres/oa-20260529-203000.dump --yes
```

When a `.dump.meta` sidecar is present, the restore also verifies `artifact_type=database`, the metadata database name, the metadata environment, and the SHA-256 checksum before `pg_restore` runs. Cross-database or cross-environment recovery is allowed only with an explicit incident-approved override:

```bash
ALLOW_RESTORE_DATABASE_MISMATCH=1 ALLOW_RESTORE_ENV_MISMATCH=1 \
npm run restore:postgres -- ./backups/postgres/oa-20260529-203000.dump --yes
```

Local `pg_restore` restore:

```bash
DATABASE_URL=postgres://postgres:change-me@127.0.0.1:5432/oa \
BACKUP_USE_LOCAL_PG_RESTORE=1 \
npm run restore:postgres -- ./backups/postgres/oa-20260529-203000.dump --yes
```

File storage restore:

```bash
npm run validate:file-backup -- ./backups/files/file-storage-production-20260529-203000.tar.gz --json
npm run restore:files -- ./backups/files/file-storage-production-20260529-203000.tar.gz --yes
```

The tar-based restore script is only for `FILE_STORAGE_DRIVER=local` backups. It will fail closed for S3 object storage so operators do not accidentally restore an unrelated local directory instead of the approved object-storage recovery path.

Production file restore requires an extra guard:

```bash
APP_ENV=production ALLOW_PRODUCTION_FILE_RESTORE=1 \
npm run restore:files -- ./backups/files/file-storage-production-20260529-203000.tar.gz --yes
```

When a `.tar.gz.meta` sidecar is present, file restore verifies `artifact_type=file_storage`, the metadata environment, and the SHA-256 checksum before validating the tar archive and before clearing the target directory. Cross-environment file recovery requires the same explicit override:

```bash
ALLOW_RESTORE_ENV_MISMATCH=1 \
npm run restore:files -- ./backups/files/file-storage-production-20260529-203000.tar.gz --yes
```

Restore acceptance:

- Restore exits with code 0.
- Restore records an `ops.restore` audit row through the unified audit redaction path. In staging/production set `OPS_AUDIT_REQUIRED=1` so a missing row fails the run.
- Database restore verifies the `.dump.meta` SHA-256, `artifact_type=database`, database name, and app environment when sidecar metadata is present before running `pg_restore`; cross-database or cross-environment restores require explicit override flags.
- File restore verifies sidecar SHA-256, `artifact_type=file_storage`, and app environment when a `.meta` file is present, runs `scripts/validate-file-backup.mjs` before destructive changes, rejects empty archives plus absolute/path-traversal tar entries, clears only the configured `FILE_STORAGE_DIR`, restores the archive, and records `ops.restore` as `ops_file_storage` through the same redaction path.
- `npm run db:deploy` exits with code 0 against the restored database.
- App/API can boot against the restored database.
- `/api/auth/me` or equivalent session endpoint responds for a valid user.
- Audit rows, approval instances, approval rule snapshots, personnel masks, and export logs are present.
- Data import runs still show source name, checksum, imported row counts, and completion time.
- Uploaded attachments are present in `FILE_STORAGE_DIR` or the configured object store and can be downloaded by id.
- Leave requests and payroll batches still point at valid workflow instances after restore; payroll publish remains blocked unless the linked workflow is fully approved.
- A smoke run completes inside the RTO target of <= 4h.

## One-Command Drill

Use the full drill for staging, release candidates, and disaster-recovery rehearsals:

```bash
npm run drill:commercial
```

Default behavior:

- Uses Docker Compose services `postgres`, `api`, and `web`.
- Runs static commercial gates before container startup so brand, OpenAPI, and preflight regressions stop before destructive database work.
- Uses `http://127.0.0.1:8787` as the API base URL.
- Uses `postgresql://oa:oa_dev_password@127.0.0.1:5432/oa_commercial?schema=public` for host-side Prisma migration checks unless `DATABASE_URL` is already set.
- Requires backup and restore audit rows by default through `OPS_AUDIT_REQUIRED=1`.
- Prints the final database backup, file-storage backup, and metadata paths for release evidence.

## Incident Notes

For every production restore, record:

- Incident ID and operator.
- Database and file-storage backup paths and checksums.
- Restore start and end time.
- Migration version before and after restore.
- App/API image or build artifact version.
- Smoke-test result and unresolved gaps.
