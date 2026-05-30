import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value).digest(encoding);
}

export function assertSafeStorageKey(storageKey) {
  const key = String(storageKey || "").trim();
  if (!key || key.startsWith("/") || key.includes("\\") || /[\0-\x1f\x7f]/.test(key)) {
    const error = new Error("unsafe_file_storage_key");
    error.code = "unsafe_file_storage_key";
    throw error;
  }
  const parts = key.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    const error = new Error("unsafe_file_storage_key");
    error.code = "unsafe_file_storage_key";
    throw error;
  }
  return key;
}

function safeLocalPath(root, storageKey) {
  const key = assertSafeStorageKey(storageKey);
  const rootPath = resolve(root);
  const fullPath = resolve(rootPath, key);
  if (!fullPath.startsWith(`${rootPath}/`) && fullPath !== rootPath) {
    const error = new Error("unsafe_file_storage_key");
    error.code = "unsafe_file_storage_key";
    throw error;
  }
  return fullPath;
}

export function isUnsafeStorageKeyError(error) {
  return error?.code === "unsafe_file_storage_key" || error?.message === "unsafe_file_storage_key";
}

export function createLocalFileStorage({ rootDir }) {
  return {
    driver: "local",
    describe() {
      return { driver: "local" };
    },
    async put(storageKey, content) {
      const fullPath = safeLocalPath(rootDir, storageKey);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, { flag: "wx" });
      return { storageKey: assertSafeStorageKey(storageKey) };
    },
    async get(storageKey) {
      return readFile(safeLocalPath(rootDir, storageKey));
    },
    async delete(storageKey) {
      await unlink(safeLocalPath(rootDir, storageKey)).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    },
    async probe() {
      const storageKey = `.ready-${process.pid}-${randomUUID()}`;
      await this.put(storageKey, Buffer.from("ok"));
      await this.delete(storageKey);
    }
  };
}

function amzDates(now = new Date()) {
  const value = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: value, dateStamp: value.slice(0, 8) };
}

function encodePathSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodedKeyPath(storageKey) {
  return assertSafeStorageKey(storageKey).split("/").map(encodePathSegment).join("/");
}

function prefixedKey(prefix, storageKey) {
  const cleanPrefix = String(prefix || "").trim().replace(/^\/+|\/+$/g, "");
  return cleanPrefix ? `${cleanPrefix}/${assertSafeStorageKey(storageKey)}` : assertSafeStorageKey(storageKey);
}

function s3UrlFor(config, storageKey) {
  const endpoint = new URL(config.endpoint);
  const objectPath = encodedKeyPath(prefixedKey(config.prefix, storageKey));
  const basePath = endpoint.pathname.replace(/\/+$/g, "");
  if (config.forcePathStyle !== false) {
    endpoint.pathname = `${basePath}/${encodePathSegment(config.bucket)}/${objectPath}`;
  } else {
    endpoint.hostname = `${config.bucket}.${endpoint.hostname}`;
    endpoint.pathname = `${basePath}/${objectPath}`;
  }
  endpoint.search = "";
  return endpoint;
}

function s3SigningKey({ secretAccessKey, dateStamp, region }) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function signedS3Headers(config, { method, url, body = Buffer.alloc(0), contentType = "", now = new Date() }) {
  const payloadHash = body.length ? sha256Hex(body) : EMPTY_SHA256;
  const { amzDate, dateStamp } = amzDates(now);
  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };
  if (contentType) headers["content-type"] = contentType;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}`).join("\n");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    url.pathname,
    "",
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash
  ].join("\n");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const signature = hmac(s3SigningKey({ ...config, dateStamp }), stringToSign, "hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const { host, ...fetchHeaders } = headers;
  return { ...fetchHeaders, authorization };
}

async function assertObjectStorageResponse(response, operation) {
  if (response.ok) return;
  const detail = await response.text().catch(() => "");
  const error = new Error(`object_storage_${operation}_failed`);
  error.code = response.status === 404 ? "file_content_missing" : "object_storage_unavailable";
  error.statusCode = response.status;
  error.detail = detail.slice(0, 400);
  throw error;
}

export function createS3ObjectStorage(config, { fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("object storage fetch implementation is unavailable");
  const normalized = {
    accessKeyId: config.accessKeyId,
    bucket: config.bucket,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle !== false,
    prefix: config.prefix || "",
    region: config.region || "us-east-1",
    secretAccessKey: config.secretAccessKey
  };

  async function request(method, storageKey, { body = Buffer.alloc(0), contentType = "" } = {}) {
    const url = s3UrlFor(normalized, storageKey);
    const headers = signedS3Headers(normalized, { method, url, body, contentType, now: now() });
    const response = await fetchImpl(url, {
      method,
      headers,
      ...(method === "GET" || method === "DELETE" ? {} : { body })
    });
    await assertObjectStorageResponse(response, method.toLowerCase());
    return response;
  }

  return {
    driver: "s3",
    describe() {
      return {
        bucket: normalized.bucket,
        driver: "s3",
        endpointHost: new URL(normalized.endpoint).host,
        forcePathStyle: normalized.forcePathStyle,
        prefix: normalized.prefix,
        region: normalized.region
      };
    },
    async put(storageKey, content) {
      const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
      await request("PUT", storageKey, { body, contentType: "application/octet-stream" });
      return { storageKey: prefixedKey(normalized.prefix, storageKey) };
    },
    async get(storageKey) {
      const response = await request("GET", storageKey);
      return Buffer.from(await response.arrayBuffer());
    },
    async delete(storageKey) {
      try {
        await request("DELETE", storageKey);
      } catch (error) {
        if (error?.statusCode !== 404) throw error;
      }
    },
    async probe() {
      const storageKey = `readiness/${randomUUID()}.probe`;
      await this.put(storageKey, Buffer.from("ok"));
      await this.delete(storageKey);
    }
  };
}

export function createFileStorage(config, options = {}) {
  if (config.fileStorageDriver === "s3") {
    return createS3ObjectStorage(config.objectStorage, options);
  }
  return createLocalFileStorage({ rootDir: config.fileStorageDir });
}
