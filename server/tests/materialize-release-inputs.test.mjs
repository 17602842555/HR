import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  materializeReleaseInputs,
  parseMaterializeReleaseInputsArgs,
  writeMaterializeReleaseInputsResult
} from "../../scripts/materialize-release-inputs.mjs";

const rootDir = resolve(new URL("../..", import.meta.url).pathname);

function b64(value) {
  return Buffer.from(value).toString("base64");
}

function releaseInputEnv() {
  return {
    PRODUCTION_ENV_B64: b64("APP_ENV=production\nNODE_ENV=production\nPOSTGRES_PASSWORD=real_secret_value\n"),
    PRODUCTION_SECRETS_SIGNOFF_B64: b64(JSON.stringify({ schemaVersion: 1, kind: "secrets" })),
    HR_DATA_SIGNOFF_B64: b64(JSON.stringify({ schemaVersion: 1, kind: "hr" })),
    FILE_STORAGE_SIGNOFF_B64: b64(JSON.stringify({ schemaVersion: 1, kind: "storage" }))
  };
}

test("release input materializer writes only approved private files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-release-inputs-"));
  try {
    const result = materializeReleaseInputs({ env: releaseInputEnv(), rootDir: dir });

    assert.equal(result.ok, true);
    assert.deepEqual(result.written.map((item) => item.path).sort(), [
      ".env.production",
      "docs/file-storage-signoff.json",
      "docs/hr-data-signoff.json",
      "docs/production-secrets-signoff.json"
    ]);

    const envText = await readFile(join(dir, ".env.production"), "utf8");
    assert.match(envText, /APP_ENV=production/);
    assert.equal((await stat(join(dir, ".env.production"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "docs/production-secrets-signoff.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "docs"))).mode & 0o777, 0o700);
    assert(result.written.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release input materializer rejects missing and malformed release secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-release-inputs-bad-"));
  try {
    const missing = materializeReleaseInputs({ env: {}, rootDir: dir });
    assert.equal(missing.ok, false);
    assert.equal(missing.errors.length, 4);
    assert(missing.errors.some((error) => error.includes("PRODUCTION_ENV_B64 is required")));

    const invalid = materializeReleaseInputs({
      env: {
        ...releaseInputEnv(),
        HR_DATA_SIGNOFF_B64: b64("{not-json")
      },
      rootDir: dir
    });
    assert.equal(invalid.ok, false);
    assert(invalid.errors.some((error) => error.includes("HR_DATA_SIGNOFF_B64 decoded content is not a valid JSON object")));

    const malformedBase64 = materializeReleaseInputs({
      env: {
        ...releaseInputEnv(),
        PRODUCTION_SECRETS_SIGNOFF_B64: "abc$not-base64"
      },
      rootDir: dir
    });
    assert.equal(malformedBase64.ok, false);
    assert(malformedBase64.errors.some((error) => error.includes("PRODUCTION_SECRETS_SIGNOFF_B64 is not valid base64")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release input materializer does not write partial files when validation fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-release-inputs-atomic-"));
  try {
    const result = materializeReleaseInputs({
      env: {
        ...releaseInputEnv(),
        FILE_STORAGE_SIGNOFF_B64: b64("{not-json")
      },
      rootDir: dir
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.written, []);
    await assert.rejects(stat(join(dir, ".env.production")), { code: "ENOENT" });
    await assert.rejects(stat(join(dir, "docs", "production-secrets-signoff.json")), { code: "ENOENT" });
    await assert.rejects(stat(join(dir, "docs", "hr-data-signoff.json")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release input materializer accepts unpadded base64 but rejects invalid utf8", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-release-inputs-base64-"));
  try {
    const env = releaseInputEnv();
    env.HR_DATA_SIGNOFF_B64 = b64(JSON.stringify({ schemaVersion: 1, kind: "hr" })).replace(/=+$/, "");
    const unpadded = materializeReleaseInputs({ env, rootDir: dir });
    assert.equal(unpadded.ok, true);

    const invalidUtf8 = materializeReleaseInputs({
      env: {
        ...releaseInputEnv(),
        HR_DATA_SIGNOFF_B64: "//79"
      },
      rootDir: dir
    });
    assert.equal(invalidUtf8.ok, false);
    assert(invalidUtf8.errors.some((error) => error.includes("does not round-trip cleanly as UTF-8")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release input materializer writes private validation manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-release-inputs-output-"));
  try {
    const result = materializeReleaseInputs({ env: releaseInputEnv(), rootDir: dir });
    const relativePath = writeMaterializeReleaseInputsResult(result, {
      outputPath: "reports/commercial-evidence/signoff-validation/release-inputs.json",
      rootDir: dir
    });

    assert.equal(relativePath, "reports/commercial-evidence/signoff-validation/release-inputs.json");
    const manifestPath = join(dir, relativePath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.ok, true);
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "reports/commercial-evidence/signoff-validation"))).mode & 0o777, 0o700);
    assert.doesNotMatch(JSON.stringify(manifest), /real_secret_value/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release input materializer CLI writes private output without shell redirection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-release-inputs-cli-"));
  try {
    const result = spawnSync(process.execPath, [
      join(rootDir, "scripts/materialize-release-inputs.mjs"),
      "--json",
      "--output",
      "reports/commercial-evidence/signoff-validation/release-inputs.json"
    ], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...releaseInputEnv() }
    });

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.outputPath, "reports/commercial-evidence/signoff-validation/release-inputs.json");
    const manifestPath = join(dir, parsed.outputPath);
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(manifestPath, "utf8"), /real_secret_value/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release input materializer parser supports json flag", () => {
  assert.deepEqual(parseMaterializeReleaseInputsArgs(["--json", "--output", "release-inputs.json"]), {
    json: true,
    outputPath: "release-inputs.json"
  });
  assert.deepEqual(parseMaterializeReleaseInputsArgs([]), { json: false, outputPath: "" });
});
