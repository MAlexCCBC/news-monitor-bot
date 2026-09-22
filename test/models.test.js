import test from "node:test";
import assert from "node:assert/strict";

import { describeGeminiError, filterCoolingModels, filterRateLimitedModels, recordModelFailure, recordModelRequest } from "../src/ai/models.js";

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

test("local RPM guard keeps Gemini 3.8 below its observed five-requests-per-minute quota", () => {
  const now = 50_000;
  for (let index = 0; index < 4; index++) recordModelRequest("gemini-3.8-flash", now - index * 5_000);

  assert.deepEqual(
    filterRateLimitedModels(["gemini-3.8-flash", "gemini-3.5-flash-lite"], now),
    ["gemini-3.5-flash-lite"]
  );
  assert.deepEqual(
    filterRateLimitedModels(["gemini-3.8-flash", "gemini-3.5-flash-lite"], now + 60_000),
    ["gemini-3.8-flash", "gemini-3.5-flash-lite"]
  );
});

test("daily and per-minute quota errors get cooldowns matched to their reset windows", () => {
  const now = 100_000;
  recordModelFailure("test-daily-quota", {
    response: { status: 429, data: { error: { details: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel" }] } } },
  }, now);
  recordModelFailure("test-minute-quota", {
    response: { status: 429, data: { error: { details: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }] } } },
  }, now);

  assert.deepEqual(filterCoolingModels(["test-minute-quota", "ready"], now + 59_999), ["ready"]);
  assert.deepEqual(filterCoolingModels(["test-minute-quota", "ready"], now + 60_000), ["test-minute-quota", "ready"]);
  assert.deepEqual(filterCoolingModels(["test-daily-quota", "ready"], now + 60_001), ["ready"]);
});

test("models all in cooldown are skipped instead of retrying the least-cooled model", () => {
  const now = 200_000;
  recordModelFailure("test-all-cooldown-a", { response: { status: 429 } }, now);
  recordModelFailure("test-all-cooldown-b", { response: { status: 429 } }, now);

  assert.deepEqual(filterCoolingModels(["test-all-cooldown-a", "test-all-cooldown-b"], now + 1), []);
});

test("Gemini error formatting preserves server quota details for diagnosis", () => {
  assert.equal(
    describeGeminiError({
      message: "Request failed with status code 429",
      response: { status: 429, data: { error: { status: "RESOURCE_EXHAUSTED", message: "Per-day quota exceeded" } } },
    }),
    "HTTP 429: RESOURCE_EXHAUSTED: Per-day quota exceeded"
  );
});
