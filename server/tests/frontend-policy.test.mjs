import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { apiUnavailableStatus, resolveApiPolicy } from "../../src/config/apiPolicy.mjs";
import { apiActionErrorStatus, canFallbackToLocalAction } from "../../src/services/apiFallbackPolicy.mjs";
import {
  STORAGE_KEY,
  localStatePersistenceAllowed,
  readStoredState,
  writeStoredState
} from "../../src/services/storage.js";

const root = resolve(new URL("../..", import.meta.url).pathname);

function readText(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value))
  };
}

test("frontend API policy allows demo fallback only for development or explicit demo builds", () => {
  assert.deepEqual(resolveApiPolicy({ DEV: true, PROD: false }), {
    allowDemoFallback: true,
    requireApi: false
  });
  assert.deepEqual(resolveApiPolicy({ DEV: false, PROD: false, VITE_DEMO_FALLBACK: "1" }), {
    allowDemoFallback: true,
    requireApi: false
  });
});

test("frontend API policy forbids silent demo fallback in production or API-required builds", () => {
  assert.deepEqual(resolveApiPolicy({ DEV: false, PROD: true }), {
    allowDemoFallback: false,
    requireApi: true
  });
  assert.deepEqual(resolveApiPolicy({ DEV: true, PROD: false, VITE_REQUIRE_API: "1", VITE_DEMO_FALLBACK: "1" }), {
    allowDemoFallback: false,
    requireApi: true
  });

  const status = apiUnavailableStatus(new Error("wrong backend"), { PROD: true });
  assert.equal(status.mode, "api_required");
  assert.equal(status.source, "api");
  assert.match(status.error, /wrong backend/);
});

test("frontend local state persistence is disabled in production and API-required builds", () => {
  const storage = memoryStorage();

  assert.equal(localStatePersistenceAllowed({ DEV: true, PROD: false }), true);
  assert.equal(localStatePersistenceAllowed({ DEV: false, PROD: false, VITE_DEMO_FALLBACK: "1" }), true);
  assert.equal(localStatePersistenceAllowed({ DEV: false, PROD: true }), false);
  assert.equal(localStatePersistenceAllowed({ DEV: true, PROD: false, VITE_REQUIRE_API: "1", VITE_DEMO_FALLBACK: "1" }), false);

  assert.equal(writeStoredState({ approvals: ["demo"] }, { env: { DEV: true, PROD: false }, storage }), true);
  assert.deepEqual(readStoredState({ env: { DEV: true, PROD: false }, storage }), { approvals: ["demo"] });
  assert.deepEqual(readStoredState({ env: { PROD: true }, storage }), null);

  assert.equal(writeStoredState({ people: { sensitive: "stale" } }, { env: { PROD: true }, storage }), false);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("frontend action fallback only applies to demo network failures", () => {
  const demoPolicy = { allowDemoFallback: true, requireApi: false };
  const requiredPolicy = { allowDemoFallback: false, requireApi: true };

  assert.equal(canFallbackToLocalAction({ status: 0, code: "NETWORK_ERROR" }, demoPolicy), true);
  assert.equal(canFallbackToLocalAction({ status: 0, code: "API_TIMEOUT" }, demoPolicy), true);
  assert.equal(canFallbackToLocalAction({ status: 403, code: "permission_denied" }, demoPolicy), false);
  assert.equal(canFallbackToLocalAction({ status: 409, code: "duplicate_import" }, demoPolicy), false);
  assert.equal(canFallbackToLocalAction({ status: 422, code: "validation_error" }, demoPolicy), false);
  assert.equal(canFallbackToLocalAction({ status: 0, code: "NETWORK_ERROR" }, requiredPolicy), false);
});

test("frontend action failure status keeps API as source for business errors", () => {
  const duplicateError = new Error("duplicate import");
  duplicateError.status = 409;
  duplicateError.code = "duplicate_import";

  assert.deepEqual(apiActionErrorStatus(duplicateError, { allowDemoFallback: true, requireApi: false }), {
    error: "duplicate import",
    mode: "degraded",
    source: "api"
  });

  assert.deepEqual(apiActionErrorStatus(duplicateError, { allowDemoFallback: false, requireApi: true }), {
    error: "duplicate import",
    mode: "degraded",
    source: "api"
  });
});

test("commercial web image build forces API-required frontend output", () => {
  const dockerfile = readText("Dockerfile.web");
  const compose = readText("docker-compose.yml");
  const storage = readText("src/services/storage.js");

  assert.match(dockerfile, /ARG VITE_REQUIRE_API=1/);
  assert.match(dockerfile, /ARG VITE_DEMO_FALLBACK=0/);
  assert.match(dockerfile, /ENV VITE_REQUIRE_API=\$\{VITE_REQUIRE_API\}/);
  assert.match(dockerfile, /ENV VITE_DEMO_FALLBACK=\$\{VITE_DEMO_FALLBACK\}/);
  assert.match(compose, /VITE_REQUIRE_API:\s+"1"/);
  assert.match(compose, /VITE_DEMO_FALLBACK:\s+"0"/);
  assert.match(storage, /localStatePersistenceAllowed/);
  assert.match(storage, /removeItem\(STORAGE_KEY\)/);
});
