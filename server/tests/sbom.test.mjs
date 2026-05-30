import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  generateSpdxSbomData,
  parseSbomArgs,
  summarizeSbom
} from "../../scripts/generate-sbom.mjs";

const packageJson = {
  name: "group-oa",
  version: "1.2.3",
  license: "UNLICENSED",
  dependencies: {
    fastify: "^5.0.0"
  },
  devDependencies: {
    prisma: "^6.0.0"
  }
};

function validLock() {
  return {
    lockfileVersion: 3,
    packages: {
      "": {
        name: "group-oa",
        version: "1.2.3",
        dependencies: { fastify: "^5.0.0" },
        devDependencies: { prisma: "^6.0.0" }
      },
      "node_modules/fastify": {
        version: "5.0.0",
        resolved: "https://registry.npmjs.org/fastify/-/fastify-5.0.0.tgz",
        integrity: "sha512-YWJjZA==",
        license: "MIT",
        dependencies: { "@fastify/error": "^4.0.0" }
      },
      "node_modules/@fastify/error": {
        version: "4.0.0",
        resolved: "https://registry.npmjs.org/@fastify/error/-/error-4.0.0.tgz",
        integrity: "sha512-ZWZnaA==",
        license: "MIT"
      },
      "node_modules/prisma": {
        version: "6.0.0",
        resolved: "https://registry.npmjs.org/prisma/-/prisma-6.0.0.tgz",
        integrity: "sha512-cHJpc21h",
        license: "Apache-2.0"
      }
    }
  };
}

test("SBOM generator creates SPDX 2.3 packages relationships checksums and purl refs", () => {
  const sbom = generateSpdxSbomData({
    lock: validLock(),
    packageJson,
    createdAt: "2026-05-30T00:00:00.000Z"
  });

  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.dataLicense, "CC0-1.0");
  assert.equal(sbom.packages.length, 4);
  assert(sbom.documentNamespace.includes("/"));
  assert(sbom.relationships.some((rel) => rel.relationshipType === "DEPENDS_ON" && rel.relatedSpdxElement.includes("fastify")));

  const fastify = sbom.packages.find((pkg) => pkg.name === "fastify");
  assert.equal(fastify.downloadLocation, "https://registry.npmjs.org/fastify/-/fastify-5.0.0.tgz");
  assert.deepEqual(fastify.checksums, [{ algorithm: "SHA512", checksumValue: "61626364" }]);
  assert.equal(fastify.externalRefs[0].referenceLocator, "pkg:npm/fastify@5.0.0");

  const scoped = sbom.packages.find((pkg) => pkg.name === "@fastify/error");
  assert.equal(scoped.externalRefs[0].referenceLocator, "pkg:npm/%40fastify/error@4.0.0");
});

test("SBOM summary keeps a stable source hash across generation timestamps", () => {
  const firstSbom = generateSpdxSbomData({
    lock: validLock(),
    packageJson,
    createdAt: "2026-05-30T00:00:00.000Z"
  });
  const secondSbom = generateSpdxSbomData({
    lock: validLock(),
    packageJson,
    createdAt: "2026-05-30T00:01:00.000Z"
  });
  const first = summarizeSbom(firstSbom, "reports/commercial-evidence/sbom/latest-spdx.json");
  const second = summarizeSbom(secondSbom, "reports/commercial-evidence/sbom/latest-spdx.json");

  assert.equal(first.packageCount, 4);
  assert.equal(first.relationshipCount, firstSbom.relationships.length);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.stableSha256, second.stableSha256);
  assert.notEqual(first.documentSha256, second.documentSha256);
});

test("SBOM CLI parser supports custom paths check mode and JSON output", () => {
  const args = parseSbomArgs([
    "--check",
    "--json",
    "--lock",
    "custom-lock.json",
    "--package",
    "custom-package.json",
    "--output",
    "custom-sbom.json"
  ]);

  assert.equal(args.check, true);
  assert.equal(args.json, true);
  assert.equal(args.lockPath, "custom-lock.json");
  assert.equal(args.packagePath, "custom-package.json");
  assert.equal(args.outputPath, "custom-sbom.json");
});

test("SBOM CLI writes private SPDX output by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oa-sbom-"));
  const lockPath = join(dir, "package-lock.json");
  const packagePath = join(dir, "package.json");
  const outputPath = join(dir, "latest-spdx.json");
  try {
    await writeFile(lockPath, JSON.stringify(validLock()), "utf8");
    await writeFile(packagePath, JSON.stringify(packageJson), "utf8");
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, [
      "scripts/generate-sbom.mjs",
      "--json",
      "--lock",
      lockPath,
      "--package",
      packagePath,
      "--output",
      outputPath
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.summary.packageCount, 4);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    const written = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(written.spdxVersion, "SPDX-2.3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
