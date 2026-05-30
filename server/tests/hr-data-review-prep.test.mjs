import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  escapeCsvCell,
  parseHrDataReviewArgs,
  prepareHrDataReview
} from "../../scripts/prepare-hr-data-review.mjs";
import { requiredMaskedFields, sha256File } from "../../scripts/validate-hr-signoff.mjs";

function modeOf(stats) {
  return stats.mode & 0o777;
}

test("HR data review prep writes masked reviewer package from dashboard source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-hr-data-review-"));

  try {
    const result = prepareHrDataReview({
      rootDir: process.cwd(),
      outputDir: dir,
      now: new Date("2026-05-30T12:34:56.000Z")
    });

    const csvText = await readFile(result.files.peopleReviewCsv, "utf8");
    const summary = JSON.parse(await readFile(result.files.summary, "utf8"));
    const manifest = JSON.parse(await readFile(result.files.manifest, "utf8"));
    const readme = await readFile(result.files.readme, "utf8");
    const latestManifest = join(dir, "latest-manifest.json");

    assert.equal(summary.kind, "hr-data-review-preparation");
    assert.equal(summary.source.counts.activeEmployees, 72);
    assert.equal(summary.source.counts.leavers, 162);
    assert.equal(summary.source.counts.femaleEmployees, 43);
    assert.equal(summary.source.counts.monthLeavers, 4);
    assert.equal(summary.source.counts.totalReviewRows, 234);
    assert.equal(summary.source.sourceChecksum, sha256File("oa-dashboard.html"));
    assert.equal(summary.reviewPolicy.noSensitiveFields, true);
    assert.equal(summary.reviewPolicy.maskedIdentityFields.includes("name"), true);

    assert.equal(manifest.kind, "hr-data-review-preparation");
    assert.equal(manifest.noSensitiveFields, true);
    assert.equal(manifest.nextCommands.some((command) => command.includes("validate:hr-signoff")), true);
    assert.equal(manifest.files.peopleReviewCsv.endsWith("people-review.csv"), true);
    assert.match(readme, /not release evidence/i);
    assert.match(readme, /No sensitive fields/i);

    const lines = csvText.trimEnd().split("\n");
    assert.equal(lines.length, 235);
    assert.equal(lines[0].includes("maskedName"), true);
    assert.equal(lines[0].includes("name,"), false);
    assert.equal(lines.some((line) => line.includes(",active-employees")), true);
    assert.equal(lines.some((line) => line.includes(",leavers")), true);
    assert.equal(modeOf(await stat(dir)), 0o700);
    assert.equal(modeOf(await stat(result.outputDir)), 0o700);
    assert.equal(modeOf(await stat(result.files.peopleReviewCsv)), 0o600);
    assert.equal(modeOf(await stat(result.files.manifest)), 0o600);
    assert.equal(modeOf(await stat(latestManifest)), 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HR data review prep keeps sensitive fields out of the CSV contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-hr-data-review-sensitive-"));

  try {
    const result = prepareHrDataReview({
      rootDir: process.cwd(),
      outputDir: dir,
      now: new Date("2026-05-30T12:34:56.000Z")
    });
    const csvText = await readFile(result.files.peopleReviewCsv, "utf8");
    const header = csvText.slice(0, csvText.indexOf("\n")).toLowerCase();
    const forbidden = [...requiredMaskedFields, "idCard", "bankAccount", "phone", "address", "salary"];

    forbidden.forEach((field) => {
      assert.equal(header.includes(field.toLowerCase()), false, `CSV header leaked ${field}`);
    });
    assert.equal(/身份证|银行卡|电话|手机号|住址|薪资|户口|学校|专业|年龄/.test(csvText), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("HR data review prep parser and CSV escaping are explicit", () => {
  const parsed = parseHrDataReviewArgs([
    "--output",
    "reports/hr-review",
    "--source",
    "oa-dashboard.html",
    "--json"
  ]);

  assert.equal(parsed.outputDir, "reports/hr-review");
  assert.equal(parsed.sourcePath, "oa-dashboard.html");
  assert.equal(parsed.json, true);
  assert.equal(escapeCsvCell("=1+1"), "'=1+1");
  assert.equal(escapeCsvCell(" +SUM(A1:A2)"), "' +SUM(A1:A2)");
  assert.equal(escapeCsvCell("safe"), "safe");
});
