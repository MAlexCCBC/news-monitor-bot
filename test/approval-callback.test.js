import test from "node:test";
import assert from "node:assert/strict";

import { answerCallbackSafely, closeStaleApprovalMessage, parseApprovalCallback } from "../src/telegram/approval-callback.js";

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

test("a clicked orphan approval prompt is closed and its buttons are removed", async () => {
  let edit;
  const result = await closeStaleApprovalMessage({
    editMessageText: async (...args) => { edit = args; },
  }, {
    message: { message_id: 5061, chat: { id: 12345 } },
  });

  assert.equal(result, true);
  assert.match(edit[0], /deja procesată sau a expirat/);
  assert.deepEqual(edit[1], {
    chat_id: 12345,
    message_id: 5061,
    reply_markup: { inline_keyboard: [] },
  });
});
