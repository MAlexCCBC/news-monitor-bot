import test from "node:test";
import assert from "node:assert/strict";

import { geminiRetryDelay, withGeminiRetries } from "../src/ai/gemini-client.js";

test("Gemini 503 is not retried on the same endpoint before model fallback", async () => {
  let requests = 0;
  const delays = [];
  await assert.rejects(withGeminiRetries(async () => {
    requests++;
    throw { response: { status: 503, headers: {} } };
  }, {
    sleep: async (delay) => delays.push(delay),
    random: () => 0.5,
    onRetry: () => {},
  }));

  assert.equal(requests, 1);
  assert.deepEqual(delays, []);
});

test("transient retry honors Google's retry-after hint, capped to one minute", () => {
  assert.equal(geminiRetryDelay({ response: { headers: { "retry-after": "2.5" } } }, 1, () => 0.5), 2500);
  assert.equal(geminiRetryDelay({ response: { headers: { "retry-after": "120" } } }, 1, () => 0.5), 60_000);
});

test("quota and client errors are not retried as transient service failures", async () => {
  for (const status of [400, 429]) {
    let requests = 0;
    await assert.rejects(withGeminiRetries(async () => {
      requests++;
      throw { response: { status, headers: {} } };
    }, { sleep: async () => assert.fail("unexpected retry"), onRetry: () => {} }));
    assert.equal(requests, 1);
  }
});

test("repeated 503s across two model endpoints open a short circuit instead of flooding every model", async () => {
  for (const model of ["outage-model-a", "outage-model-b"]) {
    await assert.rejects(withGeminiRetries(async () => {
      const error = new Error("unavailable");
      error.response = { status: 503, headers: {} };
      error.config = { url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` };
      throw error;
    }, { maxRetries: 0, onRetry: () => {} }), /unavailable/);
  }

  let requests = 0;
  await assert.rejects(withGeminiRetries(async () => {
    requests++;
    return "should not be sent";
  }, { onRetry: () => {} }), (error) => error.code === "EGEMINI_CIRCUIT_OPEN");
  assert.equal(requests, 0, "the next model must not receive a request during a cross-model outage");
});
