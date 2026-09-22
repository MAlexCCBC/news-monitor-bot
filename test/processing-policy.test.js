import test from "node:test";
import assert from "node:assert/strict";

import { createArticleProcessingPolicy } from "../src/filter/processing-policy.js";

test("explicit manual links bypass every editorial and similarity gate", () => {
  assert.deepEqual(createArticleProcessingPolicy({ forceManual: true, bypassSimilarity: true }), {
    checkSeenUrl: false,
    checkMinimumContent: false,
    checkPublishedToday: false,
    checkKeywords: false,
    checkForeignRelevance: false,
    checkArticleSimilarity: false,
  });
});

test("channel bypass keeps its existing date and minimum-content checks", () => {
  assert.deepEqual(createArticleProcessingPolicy({ bypassFilters: true }), {
    checkSeenUrl: true,
    checkMinimumContent: true,
    checkPublishedToday: true,
    checkKeywords: false,
    checkForeignRelevance: false,
    checkArticleSimilarity: false,
  });
});

test("ordinary feed items keep all filtering enabled", () => {
  assert.deepEqual(createArticleProcessingPolicy(), {
    checkSeenUrl: true,
    checkMinimumContent: true,
    checkPublishedToday: true,
    checkKeywords: true,
    checkForeignRelevance: true,
    checkArticleSimilarity: true,
  });
});
