import test from "node:test";
import assert from "node:assert/strict";
import { sanitizePostAttribution } from "../src/ai/rewrite.js";
import { prepareArticlePost } from "../src/ai/prepare-post.js";

const quote = "„PSD ne costă bani, atât când este la guvernare, cât și când este în opoziție.”";
for (const note of [
  "funcția nu este precizată în articol",
  "functia nu este mentionata in sursa",
  "Funcția nu este specificată în text",
  "funcția necunoscută",
  "rolul nu este precizat în articol",
  "titlul persoanei neprecizat",
]) {
  test("missing-role attribution note is omitted: " + note, () => {
    const text = quote + " — Siegfried Mureșan (" + note + ").\n\n💬 Ce părere aveți?";
    const expected = quote + " — Siegfried Mureșan.\n\n💬 Ce părere aveți?";
    assert.equal(sanitizePostAttribution(text), expected);
    assert.equal(sanitizePostAttribution(expected), expected);
  });
}
test("source role, factual parentheses and quoted wording remain unchanged", () => {
  for (const text of [
    quote + " — Siegfried Mureșan, europarlamentar.",
    quote + " — Siegfried Mureșan (PNL).",
    "„Funcția nu este precizată în articol (a explicat autorul).” — Siegfried Mureșan",
    "În document, funcția nu este precizată în articol.",
    "„Textul funcției — funcția nu este precizată în articol (funcția necunoscută)” — Autor",
  ]) assert.equal(sanitizePostAttribution(text), text);
});
test("new prepared posts omit missing-role notes without another model request", async () => {
  let calls = 0;
  const post = await prepareArticlePost({ fullTextForKeywordCheck: "Sursa articolului" }, {
    rewrite: async () => {
      calls++;
      return { text: quote + " — Siegfried Mureșan (funcția nu este precizată în articol)." };
    },
  });
  assert.equal(calls, 1);
  assert.equal(post, quote + " — Siegfried Mureșan.");
});
test("saved pending posts omit the note without regenerating text", async () => {
  const post = await prepareArticlePost({}, {
    approvedPost: quote + " — Siegfried Mureșan (funcția nu este precizată în articol).",
    rewrite: () => assert.fail("saved text must not call a writer"),
  });
  assert.equal(post, quote + " — Siegfried Mureșan.");
});
