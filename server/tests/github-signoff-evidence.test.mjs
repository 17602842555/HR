import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildGhDownloadArgs,
  buildGhRunListArgs,
  buildGhRunViewArgs,
  buildGithubSignoffEvidenceManifest,
  fetchGithubSignoffEvidence,
  parseGithubSignoffEvidenceArgs,
  requiredSignoffValidationFiles,
  validateGithubSignoffArtifact
} from "../../scripts/github-signoff-evidence.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "oa-github-signoff-evidence-test-"));
}

function successJson(extra = {}) {
  return {
    ok: true,
    errors: [],
    warnings: [],
    ...extra
  };
}

function writeJson(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function writeSignoffArtifact(root, overrides = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const payloadFor = (name, fallback) => Object.hasOwn(overrides, name) ? overrides[name] : fallback;
  const releaseInputs = payloadFor("release-inputs.json", successJson({
    written: [
      { envName: "PRODUCTION_ENV_B64", kind: "dotenv", path: ".env.production", bytes: 128, sha256: "a".repeat(64) },
      { envName: "PRODUCTION_SECRETS_SIGNOFF_B64", kind: "json", path: "docs/production-secrets-signoff.json", bytes: 128, sha256: "b".repeat(64) },
      { envName: "HR_DATA_SIGNOFF_B64", kind: "json", path: "docs/hr-data-signoff.json", bytes: 128, sha256: "c".repeat(64) },
      { envName: "FILE_STORAGE_SIGNOFF_B64", kind: "json", path: "docs/file-storage-signoff.json", bytes: 128, sha256: "d".repeat(64) }
    ]
  }));
  const payloads = {
    "release-inputs.json": releaseInputs,
    "production-env.json": payloadFor("production-env.json", successJson()),
    "cloudflare-backend.json": payloadFor("cloudflare-backend.json", successJson()),
    "secrets-signoff.json": payloadFor("secrets-signoff.json", successJson()),
    "hr-signoff.json": payloadFor("hr-signoff.json", successJson()),
    "storage-signoff.json": payloadFor("storage-signoff.json", successJson())
  };
  for (const fileName of requiredSignoffValidationFiles) {
    if (payloads[fileName] === null) continue;
    writeJson(join(root, fileName), payloads[fileName]);
  }
}

test("GitHub signoff evidence parser defaults to commercial signoff workflow and artifact", () => {
  const options = parseGithubSignoffEvidenceArgs(["--json"], {});

  assert.equal(options.repo, "17602842555/HR");
  assert.equal(options.workflow, "commercial-signoff.yml");
  assert.equal(options.artifact, "commercial-signoff-validation");
  assert.equal(options.branch, "main");
  assert.equal(options.clean, true);
  assert.equal(options.json, true);
  assert.equal(options.promote, false);
});

test("GitHub signoff evidence parser validates ids before shelling out", () => {
  assert.throws(
    () => parseGithubSignoffEvidenceArgs(["--repo", "17602842555/HR;rm"]),
    /GitHub repository contains unsupported characters/
  );
  assert.throws(
    () => parseGithubSignoffEvidenceArgs(["--run", "abc"]),
    /run id must be numeric/
  );
});

test("GitHub signoff evidence commands use repo workflow run and artifact flags", () => {
  const options = parseGithubSignoffEvidenceArgs([
    "--repo", "acme/hr",
    "--workflow", "commercial-signoff.yml",
    "--branch", "release",
    "--run", "12345"
  ], {});

  assert.deepEqual(buildGhRunListArgs(options), [
    "run",
    "list",
    "--repo", "acme/hr",
    "--workflow", "commercial-signoff.yml",
    "--branch", "release",
    "--status", "success",
    "--limit", "1",
    "--json", "databaseId,headSha,createdAt,status,conclusion,displayTitle,workflowName,url,event"
  ]);
  assert.deepEqual(buildGhRunViewArgs(options), [
    "run",
    "view",
    "12345",
    "--repo", "acme/hr",
    "--json", "databaseId,headSha,createdAt,status,conclusion,displayTitle,workflowName,url,event"
  ]);
  assert.deepEqual(buildGhDownloadArgs(options, "/tmp/evidence"), [
    "run",
    "download",
    "12345",
    "--repo", "acme/hr",
    "--name", "commercial-signoff-validation",
    "--dir", "/tmp/evidence"
  ]);
});

test("GitHub signoff evidence validator accepts a complete validation artifact", () => {
  const root = tempRoot();
  try {
    writeSignoffArtifact(root);
    const result = validateGithubSignoffArtifact(root, { rootDir: root });

    assert.equal(result.ok, true);
    assert.equal(Object.keys(result.files).length, requiredSignoffValidationFiles.length);
    assert.equal(result.files["release-inputs.json"].ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub signoff evidence validator rejects missing failing and unsafe artifacts", () => {
  const missingRoot = tempRoot();
  const failingRoot = tempRoot();
  const unsafeRoot = tempRoot();
  try {
    writeSignoffArtifact(missingRoot, { "storage-signoff.json": null });
    assert.equal(validateGithubSignoffArtifact(missingRoot).ok, false);

    writeSignoffArtifact(failingRoot, { "production-env.json": { ok: false, errors: ["bad"], warnings: [] } });
    const failing = validateGithubSignoffArtifact(failingRoot);
    assert.equal(failing.ok, false);
    assert.match(failing.errors.join("\n"), /production-env\.json must contain ok:true/);

    writeSignoffArtifact(unsafeRoot);
    writeFileSync(join(unsafeRoot, ".env.production"), "JWT_SECRET=super-secret-production-value\n", { mode: 0o600 });
    const unsafe = validateGithubSignoffArtifact(unsafeRoot);
    assert.equal(unsafe.ok, false);
    assert.match(unsafe.errors.join("\n"), /secret-bearing release input file|unsafe secret-like text/);
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
    rmSync(failingRoot, { recursive: true, force: true });
    rmSync(unsafeRoot, { recursive: true, force: true });
  }
});

test("GitHub signoff evidence manifest redacts project paths", () => {
  const root = tempRoot();
  try {
    const options = parseGithubSignoffEvidenceArgs(["--promote"], {});
    const manifest = buildGithubSignoffEvidenceManifest({
      copied: [join(root, "reports", "commercial-evidence", "signoff-validation", "release-inputs.json")],
      downloadDir: join(root, "reports", "commercial-evidence", "github-signoff-artifact"),
      manifestPath: join(root, "reports", "commercial-evidence", "latest-github-signoff-evidence.json"),
      options,
      rootDir: root,
      run: {
        runId: "12345",
        headSha: "abc",
        url: "https://github.com/acme/hr/actions/runs/12345"
      },
      validation: {
        ok: true,
        errors: [],
        files: {
          "release-inputs.json": {
            path: join(root, "reports", "commercial-evidence", "github-signoff-artifact", "release-inputs.json"),
            ok: true
          }
        },
        validationDir: join(root, "reports", "commercial-evidence", "github-signoff-artifact"),
        warnings: []
      }
    });

    const text = JSON.stringify(manifest);
    assert.equal(text.includes(root), false);
    assert.equal(manifest.downloadDir, "[PROJECT_ROOT]/reports/commercial-evidence/github-signoff-artifact");
    assert.equal(manifest.validation.validationDir, "[PROJECT_ROOT]/reports/commercial-evidence/github-signoff-artifact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub signoff evidence fetch downloads validates promotes and enforces current SHA", async () => {
  const root = tempRoot();
  const artifact = tempRoot();
  try {
    writeSignoffArtifact(artifact);
    const options = parseGithubSignoffEvidenceArgs([
      "--dir", "reports/commercial-evidence/signoff-download",
      "--manifest", "reports/commercial-evidence/signoff-manifest.json",
      "--promote",
      "--require-current-sha",
      "--json"
    ], {});
    const commandRunner = (command, args) => {
      if (command === "git") {
        return { ok: true, status: 0, stdout: "abc123\n", stderr: "", output: "" };
      }
      if (args[0] === "run" && args[1] === "list") {
        return {
          ok: true,
          status: 0,
          stdout: JSON.stringify([{
            conclusion: "success",
            databaseId: 12345,
            headSha: "abc123",
            url: "https://github.com/acme/hr/actions/runs/12345"
          }]),
          stderr: "",
          output: ""
        };
      }
      if (args[0] === "run" && args[1] === "download") {
        const dir = args[args.indexOf("--dir") + 1];
        cpSync(artifact, dir, { recursive: true, force: true });
        return { ok: true, status: 0, stdout: "", stderr: "", output: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    const manifest = await fetchGithubSignoffEvidence(options, { commandRunner, rootDir: root });

    assert.equal(manifest.ok, true);
    assert.equal(manifest.promoted, true);
    assert.equal(existsSync(join(root, "reports", "commercial-evidence", "signoff-validation", "release-inputs.json")), true);
    assert.equal(JSON.parse(readFileSync(join(root, "reports", "commercial-evidence", "signoff-manifest.json"), "utf8")).ok, true);

    await assert.rejects(
      () => fetchGithubSignoffEvidence(options, {
        rootDir: root,
        commandRunner: (command, args, context) => {
          if (command === "git") return { ok: true, status: 0, stdout: "different\n", stderr: "", output: "" };
          return commandRunner(command, args, context);
        }
      }),
      /does not match current HEAD/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(artifact, { recursive: true, force: true });
  }
});
