import test from "node:test";
import assert from "node:assert/strict";
import { prepareArticlePost } from "../src/ai/prepare-post.js";

test("a new AI post returns directly after rewriting", async () => {
  let calls = 0;
  const post = await prepareArticlePost({ fullTextForKeywordCheck: "Articol complet" }, {
    rewrite: async (text) => { calls++; assert.equal(text, "Articol complet"); return { text: "Text generat" }; },
  });
  assert.equal(post, "Text generat");
  assert.equal(calls, 1);
});

test("legacy pending AI posts reuse saved text without another AI request", async () => {
  const post = await prepareArticlePost({}, {
    approvedPost: "Text deja generat",
    rewrite: () => { assert.fail("must not rewrite a saved post"); },
  });
  assert.equal(post, "Text deja generat");
});
