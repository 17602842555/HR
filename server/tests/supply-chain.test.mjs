import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSupplyChainArgs,
  validatePackageLockData
} from "../../scripts/validate-supply-chain.mjs";

const packageJson = {
  dependencies: {
    fastify: "^5.8.5"
  },
  devDependencies: {
    vite: "^6.0.5"
  }
};

function validLock(overrides = {}) {
  return {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: { ...packageJson.dependencies },
        devDependencies: { ...packageJson.devDependencies }
      },
      "node_modules/fastify": {
        integrity: "sha512-fastify",
        license: "MIT",
        resolved: "https://registry.npmjs.org/fastify/-/fastify-5.8.5.tgz"
      },
      "node_modules/vite": {
        integrity: "sha512-vite",
        license: "MIT",
        resolved: "https://registry.npmjs.org/vite/-/vite-6.0.5.tgz"
      },
      ...(overrides.packages || {})
    },
    ...overrides
  };
}

test("supply-chain validator accepts locked registry packages with approved licenses", () => {
  const result = validatePackageLockData({ lock: validLock(), packageJson });

  assert.equal(result.ok, true);
  assert.equal(result.summary.lockfileVersion, 3);
  assert.equal(result.summary.packageCount, 2);
  assert.equal(result.summary.allowedLicenses.includes("MIT"), true);
});

test("supply-chain validator rejects missing integrity non-registry sources and unapproved licenses", () => {
  const lock = validLock({
    packages: {
      "node_modules/fastify": {
        license: "GPL-3.0",
        resolved: "http://example.invalid/fastify.tgz"
      }
    }
  });
  const result = validatePackageLockData({ lock, packageJson });

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("missing integrity")));
  assert(result.errors.some((error) => error.includes("must resolve from https://registry.npmjs.org/")));
  assert(result.errors.some((error) => error.includes("unapproved license")));
});

test("supply-chain validator rejects declared dependencies missing from lock root", () => {
  const lock = validLock();
  delete lock.packages[""].dependencies.fastify;
  const result = validatePackageLockData({ lock, packageJson });

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.includes("missing declared dependency: fastify")));
});

test("supply-chain CLI parser reads custom paths and JSON flag", () => {
  const args = parseSupplyChainArgs(["--json", "--lock", "tmp-lock.json", "--package", "tmp-package.json"]);

  assert.deepEqual(args, {
    json: true,
    lockPath: "tmp-lock.json",
    packagePath: "tmp-package.json"
  });
});
