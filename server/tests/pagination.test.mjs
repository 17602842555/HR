import assert from "node:assert/strict";
import test from "node:test";
import { boundedQueryLimit } from "../src/lib/pagination.mjs";

test("boundedQueryLimit keeps valid positive integer limits", () => {
  assert.equal(boundedQueryLimit("25", { fallback: 100, max: 500 }), 25);
});

test("boundedQueryLimit floors decimal limits", () => {
  assert.equal(boundedQueryLimit("25.8", { fallback: 100, max: 500 }), 25);
});

test("boundedQueryLimit falls back for invalid or nonpositive limits", () => {
  assert.equal(boundedQueryLimit("not-a-number", { fallback: 100, max: 500 }), 100);
  assert.equal(boundedQueryLimit("-1", { fallback: 100, max: 500 }), 100);
  assert.equal(boundedQueryLimit("", { fallback: 100, max: 500 }), 100);
});

test("boundedQueryLimit clamps oversized limits", () => {
  assert.equal(boundedQueryLimit("999999", { fallback: 100, max: 500 }), 500);
});
