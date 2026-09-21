import test from "node:test";
import assert from "node:assert/strict";

import { answerCallbackSafely, parseApprovalCallback } from "../src/telegram/approval-callback.js";

test("process and ignore callback payloads retain the full durable request ID", () => {
  assert.deepEqual(parseApprovalCallback("proc_a123xyz"), { action: "process", id: "a123xyz" });
  assert.deepEqual(parseApprovalCallback("ign_a123xyz"), { action: "ignore", id: "a123xyz" });
  assert.equal(parseApprovalCallback("other_a123xyz"), null);
});

test("an expired Telegram callback acknowledgement is swallowed so its action can continue", async () => {
  const warnings = [];
  const answered = [];
  const result = await answerCallbackSafely(
    { answerCallbackQuery: async (id) => { answered.push(id); throw new Error("ETELEGRAM: 400 query is too old"); } },
    { id: "stale-query" },
    { text: "Se procesează" },
    { warn: (...args) => warnings.push(args) }
  );

  assert.equal(result, false);
  assert.deepEqual(answered, ["stale-query"]);
  assert.match(warnings[0][1], /query is too old/);
});
