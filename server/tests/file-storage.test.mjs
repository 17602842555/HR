import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertSafeStorageKey,
  createFileStorage,
  createLocalFileStorage,
  createS3ObjectStorage,
  isUnsafeStorageKeyError
} from "../src/lib/file-storage.mjs";

test("local file storage writes reads deletes and rejects unsafe keys", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "oa-file-storage-"));
  const storage = createLocalFileStorage({ rootDir });

  try {
    await storage.put("tenant-default/20260530/file.txt", Buffer.from("attachment"));
    assert.equal(String(await storage.get("tenant-default/20260530/file.txt")), "attachment");
    await storage.delete("tenant-default/20260530/file.txt");
    await assert.rejects(
      () => storage.get("tenant-default/20260530/file.txt"),
      /ENOENT/
    );
    assert.throws(() => assertSafeStorageKey("../outside.txt"), (error) => isUnsafeStorageKeyError(error));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("S3 object storage signs path-style requests without exposing the secret", async () => {
  const requests = [];
  const bodies = new Map();
  const fetchImpl = async (url, options = {}) => {
    const key = new URL(url).pathname;
    requests.push({
      headers: options.headers,
      method: options.method,
      path: key,
      url: String(url)
    });
    if (options.method === "PUT") {
      bodies.set(key, Buffer.from(options.body).toString("utf8"));
      return new Response("", { status: 200 });
    }
    if (options.method === "GET") {
      return new Response(bodies.get(key) || "", { status: 200 });
    }
    if (options.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 405 });
  };
  const storage = createS3ObjectStorage({
    accessKeyId: "ACCESSKEY123",
    bucket: "oa-prod-files",
    endpoint: "https://s3.company.test",
    prefix: "prod",
    region: "cn-east-1",
    secretAccessKey: "super-secret-object-key",
    forcePathStyle: true
  }, {
    fetchImpl,
    now: () => new Date("2026-05-30T08:00:00.000Z")
  });

  await storage.put("tenant-default/20260530/file.txt", Buffer.from("attachment"));
  const content = await storage.get("tenant-default/20260530/file.txt");
  await storage.delete("tenant-default/20260530/file.txt");

  assert.equal(String(content), "attachment");
  assert.deepEqual(requests.map((item) => item.method), ["PUT", "GET", "DELETE"]);
  assert.equal(requests[0].path, "/oa-prod-files/prod/tenant-default/20260530/file.txt");
  assert.match(requests[0].headers.authorization, /Credential=ACCESSKEY123\/20260530\/cn-east-1\/s3\/aws4_request/);
  assert.equal(requests[0].headers["x-amz-date"], "20260530T080000Z");
  assert.equal(requests.some((item) => JSON.stringify(item).includes("super-secret-object-key")), false);
  assert.equal(storage.describe().endpointHost, "s3.company.test");
  assert.equal(JSON.stringify(storage.describe()).includes("super-secret-object-key"), false);
});

test("createFileStorage selects S3 driver and probe writes a temporary object", async () => {
  const methods = [];
  const fetchImpl = async (url, options = {}) => {
    methods.push(options.method);
    return new Response(options.method === "DELETE" ? null : "", { status: options.method === "DELETE" ? 204 : 200 });
  };
  const storage = createFileStorage({
    fileStorageDriver: "s3",
    objectStorage: {
      accessKeyId: "ACCESSKEY123",
      bucket: "oa-prod-files",
      endpoint: "https://s3.company.test",
      prefix: "prod",
      region: "cn-east-1",
      secretAccessKey: "super-secret-object-key"
    }
  }, { fetchImpl, now: () => new Date("2026-05-30T08:00:00.000Z") });

  await storage.probe();

  assert.equal(storage.driver, "s3");
  assert.deepEqual(methods, ["PUT", "DELETE"]);
});
