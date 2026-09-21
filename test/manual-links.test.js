import test from "node:test";
import assert from "node:assert/strict";

import { createManualMessageHandler, extractBotMessageLink } from "../src/telegram/manual-links.js";

test("manual link extraction handles plain URLs with Telegram punctuation", () => {
  assert.equal(
    extractBotMessageLink({ text: "Verifică asta: https://example.com/stire?id=3)." }),
    "https://example.com/stire?id=3"
  );
});

test("manual link extraction handles Telegram text-link entities and captions", () => {
  assert.equal(
    extractBotMessageLink({ text: "articol", entities: [{ type: "text_link", url: "https://example.com/a" }] }),
    "https://example.com/a"
  );
  assert.equal(
    extractBotMessageLink({ caption: "link in caption https://example.com/b", caption_entities: [] }),
    "https://example.com/b"
  );
});

test("unsupported protocols and messages without links are ignored", () => {
  assert.equal(extractBotMessageLink({ text: "javascript:alert(1)" }), null);
  assert.equal(extractBotMessageLink({ text: "nicio știre aici" }), null);
});

test("private manual-message handler explains when the configured chat does not match", async () => {
  const sent = [];
  let processed = false;
  const handler = createManualMessageHandler({
    bot: { sendMessage: async (...args) => sent.push(args) },
    authorizedChatId: "42",
    enqueue: (fn) => fn(),
    processUrl: async () => { processed = true; },
    logger: { log() {}, warn() {}, error() {} },
  });

  await handler({ chat: { id: 84, type: "private" }, message_id: 1, text: "https://example.com/story" });

  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /NOTIFY_CHAT_ID/);
  assert.equal(processed, false);
});

test("authorized private messages without a URL receive a reply instead of being silently ignored", async () => {
  const sent = [];
  const handler = createManualMessageHandler({
    bot: { sendMessage: async (...args) => sent.push(args) },
    authorizedChatId: 42,
    enqueue: (fn) => fn(),
    processUrl: async () => assert.fail("a message without a URL must not be processed"),
    logger: { log() {}, warn() {}, error() {} },
  });

  await handler({ chat: { id: 42, type: "private" }, message_id: 7, text: "uite articolul" });

  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /nu am găsit un link/i);
  assert.equal(sent[0][2].reply_to_message_id, 7);
});

test("authorized article links are acknowledged and processed with similarity bypass", async () => {
  const sent = [];
  const edits = [];
  const processed = [];
  const handler = createManualMessageHandler({
    bot: {
      sendMessage: async (...args) => { sent.push(args); return { message_id: 99 }; },
      editMessageText: async (...args) => edits.push(args),
    },
    authorizedChatId: "42",
    enqueue: (fn) => fn(),
    processUrl: async (...args) => { processed.push(args); return { status: "done" }; },
    logger: { log() {}, warn() {}, error() {} },
  });

  await handler({ chat: { id: 42, type: "private" }, message_id: 8, text: "https://example.com/story" });

  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /Am primit linkul/);
  assert.deepEqual(processed, [["https://example.com/story", { bypassSimilarity: true }]]);
  assert.match(edits[0][0], /Gata/);
});
