import test from "node:test";
import assert from "node:assert/strict";

import { editMessageUnlessUnchanged } from "../src/telegram/message-edit.js";

test("Telegram's identical-message response is handled as a successful no-op", async () => {
  const bot = {
    async editMessageText() {
      throw new Error("ETELEGRAM: 400 Bad Request: message is not modified: specified new message content is identical");
    },
  };

  assert.equal(await editMessageUnlessUnchanged(bot, "same", {}), false);
});

test("actual Telegram edit failures still propagate for recovery and logging", async () => {
  const failure = new Error("ETELEGRAM: 502 Bad Gateway");
  const bot = { async editMessageText() { throw failure; } };

  await assert.rejects(editMessageUnlessUnchanged(bot, "new", {}), failure);
});

test("successful Telegram edits return true", async () => {
  const bot = { async editMessageText() { return true; } };
  assert.equal(await editMessageUnlessUnchanged(bot, "new", {}), true);
});
