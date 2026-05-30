import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { findForbiddenBrandReferences, runBrandCheck } from "../../scripts/brand-check.mjs";

function fixtureRoot() {
  return mkdtempSync(join(tmpdir(), "oa-brand-check-"));
}

test("brand check passes original OA deployable copy and ignores compliance docs by default", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "src", "App.jsx"), "export const title = '集团人事行政 OA';\n");
  writeFileSync(join(root, "docs", "notes.md"), "Compliance note: Feishu references are forbidden in deployable output.\n");

  const result = runBrandCheck({ rootDir: root, includePaths: ["src"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("brand check flags forbidden third-party brand copy in deployable files", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "App.jsx"), "export const title = '飞书 OA 克隆版';\n");

  const violations = findForbiddenBrandReferences({ rootDir: root, includePaths: ["src"] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, "src/App.jsx");
  assert.equal(violations[0].target, "content");
});

test("brand check flags forbidden third-party brand asset filenames", () => {
  const root = fixtureRoot();
  mkdirSync(join(root, "public", "assets"), { recursive: true });
  writeFileSync(join(root, "public", "assets", "feishu-logo.png"), "not a real image\n");

  const violations = findForbiddenBrandReferences({ rootDir: root, includePaths: ["public"] });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, "public/assets/feishu-logo.png");
  assert.equal(violations[0].target, "filename");
});
