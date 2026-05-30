import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);

function readScript(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

test("commercial CI evidence artifacts are private by default", () => {
  const script = readScript("scripts/ci-commercial.sh");

  assert.match(script, /umask 077/);
  assert.match(script, /NODE_ENV=production npm run build/);
  assert.match(script, /chmod 700 "\$\{COMMERCIAL_EVIDENCE_DIR\}"/);
  assert.match(script, /: >"\$\{API_LOG\}"/);
  assert.match(script, /chmod 600 "\$\{API_LOG\}"/);
  assert.match(script, /chmod 600 "\$\{COMMERCIAL_EVIDENCE_DIR\}\/ready\.json"/);
});

test("commercial drill evidence artifacts are private by default", () => {
  const script = readScript("scripts/commercial-drill.sh");

  assert.match(script, /umask 077/);
  assert.match(script, /chmod 700 "\$COMMERCIAL_EVIDENCE_DIR"/);
  assert.match(script, /chmod 600 "\$COMMERCIAL_EVIDENCE_DIR\/drill-summary\.json"/);
  assert.match(script, /chmod 700 "\$ROOT_DIR\/commercial-evidence"/);
  assert.match(script, /chmod 600 "\$ROOT_DIR\/commercial-evidence\/latest-drill-summary\.json"/);
});

test("local recovery drill uses private diagnostic evidence and local restore flags", () => {
  const script = readScript("scripts/local-recovery-drill.sh");

  assert.match(script, /umask 077/);
  assert.match(script, /ALLOW_LOCAL_RECOVERY_DRILL/);
  assert.match(script, /BACKUP_USE_LOCAL_PG_DUMP=1/);
  assert.match(script, /BACKUP_USE_LOCAL_PG_RESTORE=1/);
  assert.match(script, /FILE_BACKUP_USE_LOCAL=1/);
  assert.match(script, /commercial-local-recovery-drill/);
  assert.match(script, /executionMode/);
  assert.match(script, /chmod 700 "\$COMMERCIAL_EVIDENCE_DIR"/);
  assert.match(script, /chmod 600 "\$COMMERCIAL_EVIDENCE_DIR\/local-recovery-drill-summary\.json"/);
  assert.match(script, /chmod 600 "\$ROOT_DIR\/commercial-evidence\/latest-local-recovery-drill-summary\.json"/);
  assert.doesNotMatch(script, /latest-drill-summary\.json/);
  assert.doesNotMatch(script, /docker compose up/);
});

test("commercial drill workflow runs Docker drill and uploads evidence", () => {
  const workflow = readScript(".github/workflows/commercial-drill.yml");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /FILE_STORAGE_DIR="\/app\/storage\/files"/);
  assert.match(workflow, /FILE_BACKUP_USE_LOCAL="0"/);
  assert.match(workflow, /npm run drill:commercial/);
  assert.match(workflow, /npm run validate:drill-evidence -- commercial-evidence\/latest-drill-summary\.json --json/);
  assert.match(workflow, /docker compose down -v --remove-orphans/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /commercial-drill-evidence/);
  assert.doesNotMatch(workflow, /ALLOW_PRODUCTION_DRILL: "1"/);
});

test("commercial signoff workflow materializes release inputs without uploading secrets", () => {
  const workflow = readScript(".github/workflows/commercial-signoff.yml");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: \$\{\{ inputs\.target_environment \}\}/);
  assert.match(workflow, /PRODUCTION_ENV_B64: \$\{\{ secrets\.PRODUCTION_ENV_B64 \}\}/);
  assert.match(workflow, /umask 077/);
  assert.equal(countMatches(workflow, /umask 077/g), 5);
  assert.equal(countMatches(workflow, /set -euo pipefail/g), 5);
  assert.match(workflow, /npm run prepare:release-inputs -- --json --output reports\/commercial-evidence\/signoff-validation\/release-inputs\.json/);
  assert.match(workflow, /npm run validate:production-env -- \.env\.production --json/);
  assert.match(workflow, /npm run validate:secrets-signoff -- docs\/production-secrets-signoff\.json --env \.env\.production --json/);
  assert.match(workflow, /npm run validate:hr-signoff -- docs\/hr-data-signoff\.json --source oa-dashboard\.html --json/);
  assert.match(workflow, /npm run validate:storage-signoff -- "\$\{args\[@\]\}"/);
  assert.match(workflow, /commercial-signoff-validation/);
  assert.doesNotMatch(workflow, /path: \.env\.production/);
});

test("cloudflare deploy workflow verifies backend gateway after deploy", () => {
  const workflow = readScript(".github/workflows/cloudflare-deploy.yml");

  assert.match(workflow, /Deploy HR OA to Cloudflare/);
  assert.match(workflow, /cloudflare\/wrangler-action@v3/);
  assert.match(workflow, /wrangler secret put API_ORIGIN/);
  assert.match(workflow, /CLOUDFLARE_DEPLOYMENT_URL/);
  assert.match(workflow, /npm run smoke:cloudflare -- --url "\$CLOUDFLARE_DEPLOYMENT_URL" --json/);
  assert.match(workflow, /DEPLOYMENT_URL_READY/);
});
