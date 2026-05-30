import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isSafeTarEntryPath,
  validateTarArchive,
  validateTarEntries
} from "../../scripts/validate-file-backup.mjs";

test("file backup validator accepts normal tar entry paths", () => {
  assert.equal(isSafeTarEntryPath("."), true);
  assert.equal(isSafeTarEntryPath("./attachments/invoice.pdf"), true);
  assert.equal(isSafeTarEntryPath("employees/2026/photo.png"), true);

  const result = validateTarEntries(["./", "./attachments/invoice.pdf", "employees/2026/photo.png"]);
  assert.equal(result.ok, true);
  assert.equal(result.entryCount, 3);
});

test("file backup validator rejects path traversal and absolute paths", () => {
  const result = validateTarEntries([
    "./safe.txt",
    "../escape.txt",
    "nested/../../escape.txt",
    "/absolute/escape.txt",
    "C:/windows/escape.txt",
    "\\\\server\\share\\escape.txt"
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 5);
  assert(result.errors.some((error) => error.includes("../escape.txt")));
  assert(result.errors.some((error) => error.includes("/absolute/escape.txt")));
});

test("file backup validator rejects empty archives", () => {
  const result = validateTarEntries([]);

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("no entries")));
});

test("file backup validator can inspect a generated safe tarball", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-file-backup-"));
  try {
    await writeFile(join(dir, "receipt.txt"), "ok");
    const archivePath = join(dir, "files.tar.gz");
    const tar = spawnSync("tar", ["-czf", archivePath, "-C", dir, "receipt.txt"], { encoding: "utf8" });
    assert.equal(tar.status, 0, tar.stderr);

    const result = validateTarArchive(archivePath);
    assert.equal(result.ok, true);
    assert.equal(result.entryCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
