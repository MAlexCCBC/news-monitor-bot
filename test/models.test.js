import test from "node:test";
import assert from "node:assert/strict";

import db, { getActiveModelCooldowns, saveModelCooldown } from "../src/storage/db.js";
import { describeGeminiError, eligibleModels, filterCoolingModels, recordModelFailure } from "../src/ai/models.js";
import { extractFinalRewriteText, TEXT_MODELS } from "../src/ai/rewrite.js";

test("rewrite cascade keeps Gemini 3.8 first and excludes retired 2.5 endpoints", () => {
  assert.equal(TEXT_MODELS[0], "gemini-3.8-flash");
  assert.ok(TEXT_MODELS.includes("gemini-3-flash-preview"));
  assert.ok(!TEXT_MODELS.includes("gemini-2.5-flash"));
  assert.ok(!TEXT_MODELS.includes("gemini-2.5-flash-lite"));
  assert.ok(TEXT_MODELS.indexOf("gemini-3.7-flash") < TEXT_MODELS.indexOf("gemini-3.5-flash-lite"));
});

test("eligible model cascade doesn't apply local quota counters and retains supported fallbacks", () => {
  const models = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3-flash-preview"];
  assert.deepEqual(eligibleModels(models, models), models);
  assert.deepEqual(eligibleModels(models, null), models);
  assert.deepEqual(eligibleModels(models, ["not-a-preferred-model"]), models);
});

test("rewrite output excludes Gemini thought parts and keeps only the final answer", () => {
  const text = extractFinalRewriteText({ content: { parts: [
    { text: "Internal planning and draft", thought: true },
    { text: "🇷🇴 TITLU FINAL\n\nPostarea finală." },
  ] } });
  assert.equal(text, "🇷🇴 TITLU FINAL\n\nPostarea finală.");
  assert.equal(extractFinalRewriteText({ content: { parts: [{ text: "only thought", thought: true }] } }), "");
});

test("Gemini 429 cools down only the failed model and respects Retry-After", () => {
  const now = 1_000;
  recordModelFailure("test-retry-model", {
    response: { status: 429, headers: { "retry-after": "2" } },
  }, now);

  assert.deepEqual(filterCoolingModels(["test-retry-model", "test-ready-model"], now), ["test-ready-model"]);
  assert.deepEqual(filterCoolingModels(["test-retry-model", "test-ready-model"], now + 2_000), ["test-retry-model", "test-ready-model"]);
});

test("Gemini 503 does not persist a cooldown that would hide the model from the next article", () => {
  const now = 10_000;
  assert.equal(recordModelFailure("test-unavailable-model", { response: { status: 503 } }, now), false);
  assert.deepEqual(filterCoolingModels(["test-unavailable-model", "test-fallback-model"], now), ["test-unavailable-model", "test-fallback-model"]);
});

test("a real client timeout cools down only that model briefly so the next article can use other fallbacks", () => {
  const now = 12_000;
  assert.equal(recordModelFailure("test-timeout-model", { code: "ECONNABORTED", message: "timeout of 60000ms exceeded" }, now), true);
  assert.deepEqual(filterCoolingModels(["test-timeout-model", "test-ready-model"], now), ["test-ready-model"]);
  assert.deepEqual(filterCoolingModels(["test-timeout-model", "test-ready-model"], now + 60_000), ["test-timeout-model", "test-ready-model"]);
});

test("Gemini 500 receives a short cooldown to prevent repeating transient server errors", () => {
  const now = 20_000;
  recordModelFailure("test-internal-error-model", { response: { status: 500 } }, now);

  assert.deepEqual(filterCoolingModels(["test-internal-error-model", "test-fallback-model"], now), ["test-fallback-model"]);
  assert.deepEqual(filterCoolingModels(["test-internal-error-model", "test-fallback-model"], now + 60_000), ["test-internal-error-model", "test-fallback-model"]);
});

test("a retired or unavailable 404 model is skipped for 24 hours", () => {
  const now = 25_000;
  assert.equal(recordModelFailure("test-retired-model", { response: { status: 404 } }, now), true);
  assert.deepEqual(filterCoolingModels(["test-retired-model", "test-fallback-model"], now + 1), ["test-fallback-model"]);
  assert.deepEqual(filterCoolingModels(["test-retired-model", "test-fallback-model"], now + 24 * 60 * 60 * 1000), ["test-retired-model", "test-fallback-model"]);
});

test("daily and per-minute quota errors get cooldowns matched to their reset windows", () => {
  const now = 100_000;
  recordModelFailure("test-daily-quota", {
    response: { status: 429, data: { error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } } },
  }, now);
  recordModelFailure("test-minute-quota", {
    response: { status: 429, data: { error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }] } } },
  }, now);

  assert.deepEqual(filterCoolingModels(["test-minute-quota", "ready"], now + 59_999), ["ready"]);
  assert.deepEqual(filterCoolingModels(["test-minute-quota", "ready"], now + 60_000), ["test-minute-quota", "ready"]);
  assert.deepEqual(filterCoolingModels(["test-daily-quota", "ready"], now + 60_001), ["ready"]);
  assert.deepEqual(filterCoolingModels(["test-daily-quota", "ready"], now + 24 * 60 * 60 * 1000), ["test-daily-quota", "ready"]);
});

test("retry duration in Google's error message is honored when RetryInfo/header is absent", () => {
  const now = 300_000;
  recordModelFailure("test-inline-retry", {
    response: {
      status: 429,
      data: { error: { status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota. Please retry in 1.624874675s." } },
    },
  }, now);

  assert.deepEqual(filterCoolingModels(["test-inline-retry"], now + 1_625), ["test-inline-retry"]);
});

test("Google's free-tier daily quota metric in the error message overrides its short retry hint", () => {
  const now = 400_000;
  recordModelFailure("test-free-tier-daily", {
    response: {
      status: 429,
      data: { error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash. Please retry in 1.6s." } },
    },
  }, now);

  assert.deepEqual(filterCoolingModels(["test-free-tier-daily"], now + 60_000), []);
  assert.deepEqual(filterCoolingModels(["test-free-tier-daily"], now + 24 * 60 * 60 * 1000), ["test-free-tier-daily"]);
});

test("legacy heuristic cooldown rows do not suppress models after the corrected rollout", () => {
  db.prepare("INSERT OR REPLACE INTO ai_model_cooldowns (model, cooldown_until, cooldown_version) VALUES (?, ?, 1)")
    .run("test-legacy-cooldown", Date.now() + 24 * 60 * 60 * 1000);

  assert.equal(getActiveModelCooldowns().some(({ model }) => model === "test-legacy-cooldown"), false);

  const freshCooldown = Date.now() + 2_000;
  saveModelCooldown("test-legacy-cooldown", freshCooldown);
  const migrated = getActiveModelCooldowns().find(({ model }) => model === "test-legacy-cooldown");
  assert.equal(migrated.cooldown_until, freshCooldown);
});

test("models all in cooldown are skipped instead of retrying the least-cooled model", () => {
  const now = 200_000;
  recordModelFailure("test-all-cooldown-a", { response: { status: 429 } }, now);
  recordModelFailure("test-all-cooldown-b", { response: { status: 429 } }, now);

  assert.deepEqual(filterCoolingModels(["test-all-cooldown-a", "test-all-cooldown-b"], now + 1), []);
});

test("quota cooldowns are persisted for the next GitHub Actions runner", () => {
  const now = Date.now();
  recordModelFailure("test-persisted-quota", { response: { status: 429 } }, now);

  assert.ok(getActiveModelCooldowns(now).some(({ model, cooldown_until }) =>
    model === "test-persisted-quota" && cooldown_until > now
  ));
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
