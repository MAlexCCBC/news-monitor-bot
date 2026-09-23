import test from "node:test";
import assert from "node:assert/strict";

import { geminiRetryDelay, isRequestTimeout, withGeminiRetries } from "../src/ai/gemini-client.js";

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

test("client timeouts go straight to model fallback instead of waiting through same-model retries", async () => {
  let requests = 0;
  await assert.rejects(withGeminiRetries(async () => {
    requests++;
    const error = new Error("timeout of 60000ms exceeded");
    error.code = "ECONNABORTED";
    throw error;
  }, { sleep: async () => assert.fail("timeout must not be retried"), onRetry: () => {} }));

  assert.equal(requests, 1);
  assert.equal(isRequestTimeout({ code: "ETIMEDOUT" }), true);
  assert.equal(isRequestTimeout(new Error("timeout of 60000ms exceeded")), true);
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
