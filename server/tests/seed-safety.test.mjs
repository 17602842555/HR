import assert from "node:assert/strict";
import test from "node:test";
import { assertSeedSafety } from "../../scripts/seed-safety.mjs";

test("seed safety allows non-production demo bootstrap", () => {
  assert.deepEqual(assertSeedSafety({ NODE_ENV: "development" }), { ok: true, production: false });
});

test("seed safety blocks production seed without explicit approval", () => {
  assert.throws(
    () => assertSeedSafety({
      NODE_ENV: "production",
      DEFAULT_ADMIN_PASSWORD: "StrongSeedPassword123",
      FILE_STORAGE_DIR: "/var/lib/oa/files"
    }),
    /ALLOW_PRODUCTION_SEED/
  );
});

test("seed safety blocks production default or missing admin password", () => {
  assert.throws(
    () => assertSeedSafety({
      NODE_ENV: "production",
      ALLOW_PRODUCTION_SEED: "1",
      FILE_STORAGE_DIR: "/var/lib/oa/files"
    }),
    /DEFAULT_ADMIN_PASSWORD/
  );

  assert.throws(
    () => assertSeedSafety({
      NODE_ENV: "production",
      ALLOW_PRODUCTION_SEED: "1",
      DEFAULT_ADMIN_PASSWORD: "admin123456",
      FILE_STORAGE_DIR: "/var/lib/oa/files"
    }),
    /DEFAULT_ADMIN_PASSWORD/
  );
});

test("seed safety applies password policy to production bootstrap password", () => {
  assert.throws(
    () => assertSeedSafety({
      NODE_ENV: "production",
      ALLOW_PRODUCTION_SEED: "1",
      DEFAULT_ADMIN_PASSWORD: "weak",
      FILE_STORAGE_DIR: "/var/lib/oa/files"
    }),
    /password policy/
  );
});

test("seed safety requires absolute production file storage path", () => {
  assert.throws(
    () => assertSeedSafety({
      NODE_ENV: "production",
      ALLOW_PRODUCTION_SEED: "1",
      DEFAULT_ADMIN_PASSWORD: "StrongSeedPassword123",
      FILE_STORAGE_DIR: ".local-files"
    }),
    /FILE_STORAGE_DIR/
  );
});

test("seed safety rejects temporary production file storage path", () => {
  assert.throws(
    () => assertSeedSafety({
      NODE_ENV: "production",
      ALLOW_PRODUCTION_SEED: "1",
      DEFAULT_ADMIN_PASSWORD: "StrongSeedPassword123",
      FILE_STORAGE_DIR: "/tmp/oa-files"
    }),
    /temporary storage/
  );
});

test("seed safety accepts reviewed production seed inputs", () => {
  assert.deepEqual(
    assertSeedSafety({
      NODE_ENV: "production",
      ALLOW_PRODUCTION_SEED: "1",
      DEFAULT_ADMIN_PASSWORD: "StrongSeedPassword123",
      FILE_STORAGE_DIR: "/var/lib/oa/files"
    }),
    { ok: true, production: true }
  );
});

test("seed safety rejects unsafe S3 production seed storage config", () => {
  assert.throws(
    () => assertSeedSafety({
      NODE_ENV: "production",
      ALLOW_PRODUCTION_SEED: "1",
      DEFAULT_ADMIN_PASSWORD: "StrongSeedPassword123",
      FILE_STORAGE_DRIVER: "s3",
      OBJECT_STORAGE_ENDPOINT: "http://s3.company.test",
      OBJECT_STORAGE_BUCKET: "oa-prod-files",
      OBJECT_STORAGE_REGION: "cn-east-1",
      OBJECT_STORAGE_ACCESS_KEY_ID: "AKIAREALACCESS",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "object-secret-at-least-16"
    }),
    /OBJECT_STORAGE_ENDPOINT/
  );

  assert.throws(
    () => assertSeedSafety({
      NODE_ENV: "production",
      ALLOW_PRODUCTION_SEED: "1",
      DEFAULT_ADMIN_PASSWORD: "StrongSeedPassword123",
      FILE_STORAGE_DRIVER: "s3",
      OBJECT_STORAGE_ENDPOINT: "https://s3.example.com",
      OBJECT_STORAGE_BUCKET: "oa-prod-files",
      OBJECT_STORAGE_REGION: "cn-east-1",
      OBJECT_STORAGE_ACCESS_KEY_ID: "AKIAREALACCESS",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "object-secret-at-least-16"
    }),
    /example\.com/
  );

  assert.throws(
    () => assertSeedSafety({
      NODE_ENV: "production",
      ALLOW_PRODUCTION_SEED: "1",
      DEFAULT_ADMIN_PASSWORD: "StrongSeedPassword123",
      FILE_STORAGE_DRIVER: "s3",
      OBJECT_STORAGE_ENDPOINT: "https://s3.company.test",
      OBJECT_STORAGE_BUCKET: "oa-prod-files",
      OBJECT_STORAGE_REGION: "cn-east-1",
      OBJECT_STORAGE_ACCESS_KEY_ID: "placeholder-access",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "short"
    }),
    /non-placeholder OBJECT_STORAGE_ACCESS_KEY_ID/
  );

  assert.throws(
    () => assertSeedSafety({
      NODE_ENV: "production",
      ALLOW_PRODUCTION_SEED: "1",
      DEFAULT_ADMIN_PASSWORD: "StrongSeedPassword123",
      FILE_STORAGE_DRIVER: "s3",
      OBJECT_STORAGE_ENDPOINT: "https://[::1]:9000",
      OBJECT_STORAGE_BUCKET: "oa-prod-files",
      OBJECT_STORAGE_REGION: "cn-east-1",
      OBJECT_STORAGE_ACCESS_KEY_ID: "AKIAREALACCESS",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "object-secret-at-least-16"
    }),
    /local development hosts/
  );
});

test("seed safety accepts reviewed production seed with S3 object storage", () => {
  assert.deepEqual(
    assertSeedSafety({
      NODE_ENV: "production",
      ALLOW_PRODUCTION_SEED: "1",
      DEFAULT_ADMIN_PASSWORD: "StrongSeedPassword123",
      FILE_STORAGE_DRIVER: "s3",
      OBJECT_STORAGE_ENDPOINT: "https://s3.company.test",
      OBJECT_STORAGE_BUCKET: "oa-prod-files",
      OBJECT_STORAGE_REGION: "cn-east-1",
      OBJECT_STORAGE_ACCESS_KEY_ID: "AKIAREALACCESS",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "object-secret-at-least-16"
    }),
    { ok: true, production: true }
  );

  assert.throws(
    () => assertSeedSafety({
      NODE_ENV: "production",
      ALLOW_PRODUCTION_SEED: "1",
      DEFAULT_ADMIN_PASSWORD: "StrongSeedPassword123",
      FILE_STORAGE_DRIVER: "s3",
      OBJECT_STORAGE_ENDPOINT: "https://s3.company.test"
    }),
    /OBJECT_STORAGE_BUCKET/
  );
});
