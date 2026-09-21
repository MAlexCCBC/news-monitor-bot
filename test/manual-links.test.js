import test from "node:test";
import assert from "node:assert/strict";

import { extractBotMessageLink } from "../src/telegram/manual-links.js";

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
