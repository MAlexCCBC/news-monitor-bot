import test from "node:test";
import assert from "node:assert/strict";

import { splitTelegramText } from "../src/telegram/text-chunks.js";

test("long plain Telegram posts split at paragraphs and preserve all text", () => {
  const input = `${"A".repeat(140)}\n\n${"B".repeat(140)}\n\n${"C".repeat(140)}`;
  const chunks = splitTelegramText(input, 180);

  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.join(""), input);
  assert.ok(chunks.every((chunk) => chunk.length <= 180));
  assert.ok(chunks[0].endsWith("\n\n"));
});

test("long Telegram posts do not split UTF-16 surrogate pairs", () => {
  const input = `${"x".repeat(149)}😀${"y".repeat(151)}`;
  const chunks = splitTelegramText(input, 150);

  assert.equal(chunks.join(""), input);
  assert.ok(chunks.every((chunk) => chunk.length <= 150));
  for (const chunk of chunks) {
    assert.doesNotMatch(chunk, /[\uD800-\uDBFF]$/);
    assert.doesNotMatch(chunk, /^[\uDC00-\uDFFF]/);
  }
});
