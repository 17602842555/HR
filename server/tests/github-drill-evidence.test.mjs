import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildGhDownloadArgs,
  buildGhRunListArgs,
  buildGhRunViewArgs,
  buildGithubDrillEvidenceManifest,
  fetchGithubDrillEvidence,
  parseGithubDrillEvidenceArgs
} from "../../scripts/github-drill-evidence.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "oa-github-drill-evidence-test-"));
}

test("GitHub drill evidence parser defaults to commercial drill workflow and artifact", () => {
  const options = parseGithubDrillEvidenceArgs(["--json"], {});

  assert.equal(options.repo, "17602842555/HR");
  assert.equal(options.workflow, "commercial-drill.yml");
  assert.equal(options.artifact, "commercial-drill-evidence");
  assert.equal(options.branch, "main");
  assert.equal(options.clean, true);
  assert.equal(options.json, true);
  assert.equal(options.promote, false);
});

test("GitHub drill evidence parser validates ids before shelling out", () => {
  assert.throws(
    () => parseGithubDrillEvidenceArgs(["--repo", "17602842555/HR;rm"]),
    /GitHub repository contains unsupported characters/
  );
  assert.throws(
    () => parseGithubDrillEvidenceArgs(["--run", "abc"]),
    /run id must be numeric/
  );
});

test("GitHub drill evidence commands use repo workflow run and artifact flags", () => {
  const options = parseGithubDrillEvidenceArgs([
    "--repo", "acme/hr",
    "--workflow", "commercial-drill.yml",
    "--branch", "release",
    "--run", "12345"
  ], {});

  assert.deepEqual(buildGhRunListArgs(options), [
    "run",
    "list",
    "--repo", "acme/hr",
    "--workflow", "commercial-drill.yml",
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
    "--name", "commercial-drill-evidence",
    "--dir", "/tmp/evidence"
  ]);
});

test("GitHub drill evidence manifest redacts project paths", () => {
  const root = tempRoot();
  try {
    const options = parseGithubDrillEvidenceArgs(["--promote"], {});
    const manifest = buildGithubDrillEvidenceManifest({
      copied: [join(root, "commercial-evidence")],
      downloadDir: join(root, "reports", "commercial-evidence", "github-drill-artifact"),
      manifestPath: join(root, "reports", "commercial-evidence", "latest-github-drill-evidence.json"),
      options,
      rootDir: root,
      run: {
        runId: "12345",
        headSha: "abc",
        url: "https://github.com/acme/hr/actions/runs/12345"
      },
      validation: {
        ok: true,
        summaryPath: join(root, "reports", "commercial-evidence", "github-drill-artifact", "commercial-evidence", "latest-drill-summary.json"),
        errors: [],
        warnings: [],
        evidence: {
          backupFile: join(root, "reports", "commercial-evidence", "github-drill-artifact", "backups", "postgres", "db.dump"),
          fileBackup: join(root, "reports", "commercial-evidence", "github-drill-artifact", "backups", "files", "files.tar.gz"),
          finishedAt: "2026-05-31T00:00:00.000Z",
          postRestoreSmokeEvidence: join(root, "reports", "commercial-evidence", "github-drill-artifact", "commercial-evidence", "post.json"),
          preRestoreSmokeEvidence: join(root, "reports", "commercial-evidence", "github-drill-artifact", "commercial-evidence", "pre.json")
        }
      }
    });

    const text = JSON.stringify(manifest);
    assert.equal(text.includes(root), false);
    assert.equal(manifest.downloadDir, "[PROJECT_ROOT]/reports/commercial-evidence/github-drill-artifact");
    assert.equal(manifest.validation.evidence.backupFile, "[PROJECT_ROOT]/reports/commercial-evidence/github-drill-artifact/backups/postgres/db.dump");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub drill evidence fetch fails closed when no successful run is available", async () => {
  const root = tempRoot();
  try {
    const options = parseGithubDrillEvidenceArgs(["--dir", "reports/commercial-evidence/download-test"], {});
    await assert.rejects(
      () => fetchGithubDrillEvidence(options, {
        rootDir: root,
        commandRunner: () => ({
          ok: true,
          status: 0,
          stdout: "[]",
          stderr: "",
          output: ""
        })
      }),
      /No successful commercial-drill workflow run/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
