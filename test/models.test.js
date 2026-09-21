import test from "node:test";
import assert from "node:assert/strict";

import { filterCoolingModels, recordModelFailure } from "../src/ai/models.js";

test("Gemini 429 cools down only the failed model and respects Retry-After", () => {
  const now = 1_000;
  recordModelFailure("test-retry-model", {
    response: { status: 429, headers: { "retry-after": "2" } },
  }, now);

  assert.deepEqual(filterCoolingModels(["test-retry-model", "test-ready-model"], now), ["test-ready-model"]);
  assert.deepEqual(filterCoolingModels(["test-retry-model", "test-ready-model"], now + 2_000), ["test-retry-model", "test-ready-model"]);
});

test("Gemini 503 receives a temporary cooldown, then becomes eligible again", () => {
  const now = 10_000;
  recordModelFailure("test-unavailable-model", { response: { status: 503 } }, now);

  assert.deepEqual(filterCoolingModels(["test-unavailable-model", "test-fallback-model"], now), ["test-fallback-model"]);
  assert.deepEqual(filterCoolingModels(["test-unavailable-model", "test-fallback-model"], now + 60_000), ["test-unavailable-model", "test-fallback-model"]);
});

test("Gemini 500 receives a short cooldown to prevent repeating transient server errors", () => {
  const now = 20_000;
  recordModelFailure("test-internal-error-model", { response: { status: 500 } }, now);

  assert.deepEqual(filterCoolingModels(["test-internal-error-model", "test-fallback-model"], now), ["test-fallback-model"]);
  assert.deepEqual(filterCoolingModels(["test-internal-error-model", "test-fallback-model"], now + 60_000), ["test-internal-error-model", "test-fallback-model"]);
});
