import assert from "node:assert/strict";
import test from "node:test";
import { loadEnv, runtimeConfigDefaults } from "../src/lib/env.mjs";

const strongSecret = "commercial-secret-2026-05-29-at-least-32-chars";
const productionFileStorageDir = "/var/lib/oa/files";
const productionWebOrigin = "https://oa.company.cn";

test("production runtime rejects default development JWT secret", () => {
  assert.throws(
    () => loadEnv({
      isProduction: true,
      jwtSecret: runtimeConfigDefaults.devJwtSecret,
      webOrigin: [productionWebOrigin],
      fileStorageDir: productionFileStorageDir
    }),
    /Production JWT_SECRET/
  );
});

test("production runtime rejects placeholder JWT secret", () => {
  assert.throws(
    () => loadEnv({
      isProduction: true,
      jwtSecret: runtimeConfigDefaults.placeholderJwtSecret,
      webOrigin: [productionWebOrigin],
      fileStorageDir: productionFileStorageDir
    }),
    /Production JWT_SECRET/
  );
});

test("production runtime rejects wildcard web origin", () => {
  assert.throws(
    () => loadEnv({
      isProduction: true,
      jwtSecret: strongSecret,
      webOrigin: ["*"],
      fileStorageDir: productionFileStorageDir
    }),
    /WEB_ORIGIN/
  );
});

test("production runtime rejects local http and template web origins", () => {
  for (const origin of ["http://oa.company.cn", "https://127.0.0.1:5174", "https://oa.example.com"]) {
    assert.throws(
      () => loadEnv({
        isProduction: true,
        jwtSecret: strongSecret,
        webOrigin: [origin],
        fileStorageDir: productionFileStorageDir
      }),
      /WEB_ORIGIN/
    );
  }
});

test("production runtime rejects default admin password when seed is enabled", () => {
  assert.throws(
    () => loadEnv({
      isProduction: true,
      jwtSecret: strongSecret,
      webOrigin: [productionWebOrigin],
      runDbSeed: true,
      defaultAdminPassword: runtimeConfigDefaults.defaultAdminPassword,
      fileStorageDir: productionFileStorageDir
    }),
    /default admin password/
  );
});

test("production runtime accepts explicit strong secrets", () => {
  const config = loadEnv({
    isProduction: true,
    jwtSecret: strongSecret,
    cookieMaxAgeSeconds: runtimeConfigDefaults.defaultCookieMaxAgeSeconds,
    webOrigin: [productionWebOrigin],
    runDbSeed: false,
    defaultAdminPassword: "not-used-in-production",
    fileStorageDir: productionFileStorageDir
  });

  assert.equal(config.isProduction, true);
  assert.equal(config.jwtSecret, strongSecret);
  assert.equal(config.cookieMaxAgeSeconds, 28800);
});

test("production runtime accepts S3 object storage without local volume signoff", () => {
  const config = loadEnv({
    isProduction: true,
    jwtSecret: strongSecret,
    webOrigin: [productionWebOrigin],
    runDbSeed: false,
    defaultAdminPassword: "not-used-in-production",
    fileStorageDriver: "s3",
    objectStorage: {
      accessKeyId: "AKIAREALACCESS",
      bucket: "oa-prod-files",
      endpoint: "https://s3.company.test",
      prefix: "prod",
      region: "cn-east-1",
      secretAccessKey: "object-secret-at-least-16"
    }
  });

  assert.equal(config.fileStorageDriver, "s3");
  assert.equal(config.objectStorage.bucket, "oa-prod-files");
});

test("S3 object storage driver requires complete object storage config", () => {
  assert.throws(
    () => loadEnv({
      fileStorageDriver: "s3",
      isProduction: false,
      objectStorage: { endpoint: "https://s3.company.test" }
    }),
    /OBJECT_STORAGE_BUCKET/
  );
});

test("production runtime rejects insecure object storage endpoint", () => {
  assert.throws(
    () => loadEnv({
      isProduction: true,
      jwtSecret: strongSecret,
      webOrigin: [productionWebOrigin],
      fileStorageDriver: "s3",
      objectStorage: {
        accessKeyId: "AKIAREALACCESS",
        bucket: "oa-prod-files",
        endpoint: "http://s3.company.test",
        prefix: "prod",
        region: "cn-east-1",
        secretAccessKey: "object-secret-at-least-16"
      }
    }),
    /OBJECT_STORAGE_ENDPOINT/
  );
});

test("production runtime requires explicit absolute file storage path", () => {
  assert.throws(
    () => loadEnv({
      isProduction: true,
      jwtSecret: strongSecret,
      webOrigin: [productionWebOrigin],
      runDbSeed: false
    }),
    /FILE_STORAGE_DIR/
  );

  assert.throws(
    () => loadEnv({
      isProduction: true,
      jwtSecret: strongSecret,
      webOrigin: [productionWebOrigin],
      runDbSeed: false,
      fileStorageDir: ".local-files"
    }),
    /FILE_STORAGE_DIR/
  );
});

test("production runtime rejects temporary file storage path", () => {
  assert.throws(
    () => loadEnv({
      isProduction: true,
      jwtSecret: strongSecret,
      webOrigin: [productionWebOrigin],
      runDbSeed: false,
      fileStorageDir: "/tmp/oa-files"
    }),
    /temporary storage/
  );
});

test("runtime disables forwarded proxy trust by default", () => {
  assert.equal(loadEnv({ isProduction: false }).trustProxy, false);

  const previousValue = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "1";

  try {
    assert.equal(loadEnv({ isProduction: false }).trustProxy, true);
  } finally {
    if (previousValue === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = previousValue;
    }
  }
});

test("runtime computes API body limit from upload and import limits", () => {
  const config = loadEnv({
    fileMaxUploadBytes: 5 * 1024 * 1024,
    importMaxHtmlBytes: 10 * 1024 * 1024,
    isProduction: false
  });

  assert.equal(config.apiBodyLimitBytes, runtimeConfigDefaults.requiredApiBodyLimitBytes(config));
});

test("runtime rejects invalid cookie max age", () => {
  assert.throws(
    () => loadEnv({
      cookieMaxAgeSeconds: 0,
      isProduction: false
    }),
    /COOKIE_MAX_AGE_SECONDS/
  );
});

test("runtime rejects invalid login protection limits", () => {
  assert.throws(
    () => loadEnv({
      authFailedLoginLimit: 0,
      isProduction: false
    }),
    /AUTH_FAILED_LOGIN_LIMIT/
  );

  assert.throws(
    () => loadEnv({
      authFailedLoginWindowMs: 0,
      isProduction: false
    }),
    /AUTH_FAILED_LOGIN_WINDOW_MS/
  );

  assert.throws(
    () => loadEnv({
      authFailedLoginMaxKeys: 0,
      isProduction: false
    }),
    /AUTH_FAILED_LOGIN_MAX_KEYS/
  );
});

test("runtime rejects invalid import html size limit", () => {
  assert.throws(
    () => loadEnv({
      importMaxHtmlBytes: 0,
      isProduction: false
    }),
    /IMPORT_MAX_HTML_BYTES/
  );
});

test("runtime rejects invalid file upload size limit", () => {
  assert.throws(
    () => loadEnv({
      fileMaxUploadBytes: 0,
      isProduction: false
    }),
    /FILE_MAX_UPLOAD_BYTES/
  );
});

test("runtime rejects API body limit below upload and import requirements", () => {
  assert.throws(
    () => loadEnv({
      apiBodyLimitBytes: 1024,
      fileMaxUploadBytes: 5 * 1024 * 1024,
      importMaxHtmlBytes: 10 * 1024 * 1024,
      isProduction: true,
      jwtSecret: strongSecret,
      webOrigin: [productionWebOrigin],
      fileStorageDir: productionFileStorageDir
    }),
    /API_BODY_LIMIT_BYTES/
  );
});

test("runtime rejects nonnumeric API body limit from environment", () => {
  const previousValue = process.env.API_BODY_LIMIT_BYTES;
  process.env.API_BODY_LIMIT_BYTES = "10mb";

  try {
    assert.throws(
      () => loadEnv({
        fileMaxUploadBytes: 5 * 1024 * 1024,
        importMaxHtmlBytes: 10 * 1024 * 1024,
        isProduction: false
      }),
      /API_BODY_LIMIT_BYTES/
    );
  } finally {
    if (previousValue === undefined) {
      delete process.env.API_BODY_LIMIT_BYTES;
    } else {
      process.env.API_BODY_LIMIT_BYTES = previousValue;
    }
  }
});
