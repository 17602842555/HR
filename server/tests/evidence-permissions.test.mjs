import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  auditEvidencePermissions,
  parseEvidencePermissionArgs
} from "../../scripts/validate-evidence-permissions.mjs";

async function writePrivateJson(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function writePrivateText(path, text = "ok\n") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function seedValidEvidencePackage(rootDir) {
  const evidenceDir = join(rootDir, "reports/commercial-evidence");
  const ownerDir = join(evidenceDir, "commercial-owner-handoff-20260530T020000Z");
  const hrDir = join(evidenceDir, "hr-data-review/hr-data-review-20260530T020000Z");

  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await chmod(evidenceDir, 0o700);
  await mkdir(ownerDir, { recursive: true, mode: 0o700 });
  await chmod(ownerDir, 0o700);
  await mkdir(hrDir, { recursive: true, mode: 0o700 });
  await chmod(hrDir, 0o700);

  await writePrivateJson(join(evidenceDir, "latest.json"), { ok: true });
  await writePrivateJson(join(evidenceDir, "latest-gap-report.json"), { ok: true });
  await writePrivateText(join(evidenceDir, "latest-gap-report.md"));
  await writePrivateText(join(evidenceDir, "latest-owner-handoff.md"));
  await writePrivateJson(join(evidenceDir, "latest-owner-handoff-manifest.json"), {
    directoryName: "commercial-owner-handoff-20260530T020000Z",
    owners: [{ owner: "Deployment lead", file: "01-deployment-lead.md" }]
  });
  await writePrivateText(join(ownerDir, "index.md"));
  await writePrivateJson(join(ownerDir, "manifest.json"), { ok: true });
  await writePrivateText(join(ownerDir, "01-deployment-lead.md"));
  await writePrivateJson(join(evidenceDir, "sbom/latest-spdx.json"), { spdxVersion: "SPDX-2.3" });

  await writePrivateJson(join(evidenceDir, "hr-data-review/latest-manifest.json"), {
    outputDir: "reports/commercial-evidence/hr-data-review/hr-data-review-20260530T020000Z",
    files: {
      peopleReviewCsv: "reports/commercial-evidence/hr-data-review/hr-data-review-20260530T020000Z/people-review.csv",
      summary: "reports/commercial-evidence/hr-data-review/hr-data-review-20260530T020000Z/summary.json",
      readme: "reports/commercial-evidence/hr-data-review/hr-data-review-20260530T020000Z/README.md",
      manifest: "reports/commercial-evidence/hr-data-review/hr-data-review-20260530T020000Z/manifest.json"
    }
  });
  await writePrivateText(join(hrDir, "people-review.csv"));
  await writePrivateJson(join(hrDir, "summary.json"), { ok: true });
  await writePrivateText(join(hrDir, "README.md"));
  await writePrivateJson(join(hrDir, "manifest.json"), { ok: true });

  return evidenceDir;
}

test("commercial evidence permission audit accepts private latest evidence packages", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "oa-evidence-permissions-"));
  try {
    const evidenceDir = await seedValidEvidencePackage(rootDir);
    const result = auditEvidencePermissions({ rootDir, evidenceDir });

    assert.equal(result.ok, true);
    assert.equal(result.summary.failureCount, 0);
    assert(result.summary.checkedCount >= 14);
    assert(result.warnings.some((warning) => warning.includes("optional commercial evidence production-env-prep/latest-manifest.json")));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("commercial evidence permission audit rejects group-readable latest files", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "oa-evidence-permissions-open-"));
  try {
    const evidenceDir = await seedValidEvidencePackage(rootDir);
    await chmod(join(evidenceDir, "latest.json"), 0o644);

    const result = auditEvidencePermissions({ rootDir, evidenceDir });

    assert.equal(result.ok, false);
    assert(result.failures.some((failure) => failure.includes("latest.json mode 0644 must be 0600")));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("commercial evidence permission audit rejects manifest paths outside project root", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "oa-evidence-permissions-escape-"));
  try {
    const evidenceDir = await seedValidEvidencePackage(rootDir);
    await writePrivateJson(join(evidenceDir, "hr-data-review/latest-manifest.json"), {
      outputDir: "../outside",
      files: {}
    });

    const result = auditEvidencePermissions({ rootDir, evidenceDir });

    assert.equal(result.ok, false);
    assert(result.failures.some((failure) => failure.includes("HR data review outputDir escapes project root")));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("commercial evidence permission parser reads evidence dir and json flags", () => {
  const parsed = parseEvidencePermissionArgs(["--evidence-dir", "custom/evidence", "--json"]);

  assert.equal(parsed.evidenceDir, "custom/evidence");
  assert.equal(parsed.json, true);
});
