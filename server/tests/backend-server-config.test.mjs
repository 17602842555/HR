import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureBackendServerPackage,
  listGithubSecrets,
  parseBackendServerConfigArgs,
  parseGithubSecretList
} from "../../scripts/configure-backend-server.mjs";

function modeOf(stats) {
  return stats.mode & 0o777;
}

test("backend server config packet writes private no-secret handoff with current blockers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-backend-config-"));
  try {
    const result = configureBackendServerPackage({
      rootDir: process.cwd(),
      outputDir: dir,
      now: new Date("2026-05-31T09:00:00.000Z"),
      repositorySecretNames: [
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_DEPLOYMENT_URL",
        "CLOUDFLARE_TUNNEL_TOKEN",
        "CLOUDFLARE_BACKEND_WEB_ORIGIN"
      ],
      environmentSecretNames: ["HR_DATA_SIGNOFF_B64"],
      repo: "17602842555/HR",
      tunnel: "399ce110-a343-43b5-81cd-333f5f86212c"
    });

    const manifest = JSON.parse(await readFile(result.files.manifest, "utf8"));
    const ownerInputs = JSON.parse(await readFile(result.files.ownerInputs, "utf8"));
    const githubSecrets = await readFile(result.files.githubSecrets, "utf8");
    const readme = await readFile(result.files.index, "utf8");
    const runbook = await readFile(result.files.serverRunbook, "utf8");

    assert.equal(result.ready, false);
    assert.equal(manifest.kind, "backend-server-configuration");
    assert.equal(manifest.noPlaintextSecretValues, true);
    assert.equal(manifest.production.exists, false);
    assert.deepEqual(manifest.githubSecrets.missingRepositorySecrets.sort(), [
      "API_ORIGIN",
      "CLOUDFLARE_API_TOKEN"
    ]);
    assert.deepEqual(manifest.githubSecrets.missingEnvironmentSecrets.sort(), [
      "FILE_STORAGE_SIGNOFF_B64",
      "PRODUCTION_ENV_B64",
      "PRODUCTION_SECRETS_SIGNOFF_B64"
    ]);
    assert.equal(manifest.generated.productionEnvPreparation.manifest.includes("manifest.json"), true);
    assert.equal(manifest.generated.signoffDrafts.manifest.includes("manifest.json"), true);
    assert.equal(manifest.generated.hrReview.manifest.includes("manifest.json"), true);
    assert.equal(ownerInputs.noPlaintextSecretValues, true);
    assert.equal(ownerInputs.requiredRepositorySecrets.includes("CLOUDFLARE_API_TOKEN"), true);
    assert.equal(ownerInputs.requiredEnvironmentSecrets.includes("PRODUCTION_ENV_B64"), true);
    assert.equal(ownerInputs.safeBase64SecretCommands.every((item) => item.command.includes("gh secret set")), true);
    assert.match(githubSecrets, /CLOUDFLARE_API_TOKEN/);
    assert.match(githubSecrets, /base64 < \.env\.production/);
    assert.match(readme, /Backend Server Configuration Packet/);
    assert.match(readme, /configure:cloudflare-tunnel/);
    assert.match(runbook, /docker compose -f docker-compose\.prod\.yml -f docker-compose\.cloudflare\.yml/);

    const serialized = JSON.stringify({ manifest, ownerInputs, githubSecrets, readme, runbook });
    assert.equal(serialized.includes("real_production_pg_secret"), false);
    assert.equal(serialized.includes("jwt_real_random_secret"), false);
    assert.equal(modeOf(await stat(dir)), 0o700);
    assert.equal(modeOf(await stat(result.outputDir)), 0o700);
    assert.equal(modeOf(await stat(result.files.manifest)), 0o600);
    assert.equal(modeOf(await stat(result.files.ownerInputs)), 0o600);
    assert.equal(modeOf(await stat(result.files.index)), 0o600);
    assert.equal(modeOf(await stat(join(dir, "latest-manifest.json"))), 0o600);
    assert.equal(modeOf(await stat(join(dir, "latest-index.md"))), 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backend server config can inspect GitHub secret names without values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-backend-config-gh-"));
  const calls = [];
  const runner = (command, args) => {
    calls.push({ command, args });
    if (args.includes("--env")) {
      return {
        status: 0,
        stdout: "PRODUCTION_ENV_B64\t2026-05-31T00:00:00Z\nFILE_STORAGE_SIGNOFF_B64\t2026-05-31T00:00:00Z\n",
        stderr: ""
      };
    }
    return {
      status: 0,
      stdout: "CLOUDFLARE_ACCOUNT_ID\t2026-05-30T00:00:00Z\nAPI_ORIGIN\t2026-05-31T00:00:00Z\nCLOUDFLARE_API_TOKEN\t2026-05-31T00:00:00Z\nCLOUDFLARE_DEPLOYMENT_URL\t2026-05-30T00:00:00Z\nCLOUDFLARE_TUNNEL_TOKEN\t2026-05-30T00:00:00Z\nCLOUDFLARE_BACKEND_WEB_ORIGIN\t2026-05-30T00:00:00Z\n",
      stderr: ""
    };
  };

  try {
    const result = configureBackendServerPackage({
      rootDir: process.cwd(),
      outputDir: dir,
      inspectGithubSecrets: true,
      runner,
      now: new Date("2026-05-31T09:00:00.000Z")
    });
    const manifest = JSON.parse(await readFile(result.files.manifest, "utf8"));

    assert.equal(calls.length, 2);
    assert.equal(calls.every((call) => call.command === "gh"), true);
    assert.equal(calls.some((call) => call.args.includes("--env") && call.args.includes("production")), true);
    assert.deepEqual(manifest.githubSecrets.missingRepositorySecrets, []);
    assert.deepEqual(manifest.githubSecrets.missingEnvironmentSecrets.sort(), [
      "HR_DATA_SIGNOFF_B64",
      "PRODUCTION_SECRETS_SIGNOFF_B64"
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backend server config parser reads deployment options", () => {
  const parsed = parseBackendServerConfigArgs([
    "--output",
    "reports/backend",
    "--environment",
    "staging",
    "--env",
    "release/.env.production",
    "--repo",
    "owner/repo",
    "--source",
    "oa-dashboard.html",
    "--storage-driver",
    "s3",
    "--file-storage-dir",
    "/app/storage/files",
    "--tunnel",
    "tunnel-id",
    "--inspect-github-secrets",
    "--json"
  ]);

  assert.equal(parsed.outputDir, "reports/backend");
  assert.equal(parsed.environment, "staging");
  assert.equal(parsed.envPath, "release/.env.production");
  assert.equal(parsed.repo, "owner/repo");
  assert.equal(parsed.storageDriver, "s3");
  assert.equal(parsed.fileStorageDir, "/app/storage/files");
  assert.equal(parsed.tunnel, "tunnel-id");
  assert.equal(parsed.inspectGithubSecrets, true);
  assert.equal(parsed.json, true);
});

test("github secret list parser and inspector keep only secret names", () => {
  assert.deepEqual(parseGithubSecretList("CLOUDFLARE_API_TOKEN\t2026-05-31\nbad value\nAPI_ORIGIN\t2026-05-31\n"), [
    "CLOUDFLARE_API_TOKEN",
    "API_ORIGIN"
  ]);

  const ok = listGithubSecrets({
    repo: "owner/repo",
    runner: () => ({ status: 0, stdout: "API_ORIGIN\t2026-05-31\n", stderr: "" })
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.names, ["API_ORIGIN"]);

  const failed = listGithubSecrets({
    repo: "owner/repo",
    runner: () => ({ status: 1, stdout: "", stderr: "token=super-secret-token failed" })
  });
  assert.equal(failed.ok, false);
  assert.equal(JSON.stringify(failed).includes("super-secret-token"), false);
  assert.equal(failed.errors.some((error) => error.includes("token=[REDACTED]")), true);
});
