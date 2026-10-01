import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { applyLearnedFeedback, createSimilarityFeedbackStore, feedbackLookupFrom } from "../src/storage/similarity-feedback.js";

function storeWith(windowMs) {
  const db = new Database(":memory:");
  return createSimilarityFeedbackStore(db, { windowMs });
}

test("a human decision is stored and returned for the same pair", () => {
  const feedback = storeWith();
  assert.equal(feedback.record({
    articleUrl: "https://a.example/1", articleTitle: "Știrea A",
    comparisonUrl: "https://b.example/2", decision: "distinct",
  }), true);

  const found = feedback.lookup({ articleUrl: "https://a.example/1", comparisonUrl: "https://b.example/2" });
  assert.equal(found.decision, "distinct");
  // The same pair in the other direction is a different comparison.
  assert.equal(feedback.lookup({ articleUrl: "https://b.example/2", comparisonUrl: "https://a.example/1" }), null);
});

test("an incomplete decision is not stored", () => {
  const feedback = storeWith();
  assert.equal(feedback.record({ articleUrl: "https://a.example/1", decision: "distinct" }), false);
  assert.equal(feedback.record({ articleUrl: "https://a.example/1", comparisonUrl: "https://b.example/2", decision: "maybe" }), false);
});

test("the most recent decision for a pair wins", () => {
  const feedback = storeWith();
  feedback.record({ articleUrl: "https://a.example/1", comparisonUrl: "https://b.example/2", decision: "distinct" });
  feedback.record({ articleUrl: "https://a.example/1", comparisonUrl: "https://b.example/2", decision: "same_story" });
  assert.equal(feedback.lookup({ articleUrl: "https://a.example/1", comparisonUrl: "https://b.example/2" }).decision, "same_story");
});

test("a decision stops applying once it is older than the history window", () => {
  const start = 1_700_000_000_000;
  const feedback = storeWith(60_000);
  feedback.record({
    articleUrl: "https://a.example/1", comparisonUrl: "https://b.example/2",
    decision: "same_story", now: start,
  });
  assert.ok(feedback.lookup({ articleUrl: "https://a.example/1", comparisonUrl: "https://b.example/2", now: start + 30_000 }));
  // A story on the same subject tomorrow is a new story; an old verdict must
  // not keep blocking it.
  assert.equal(feedback.lookup({ articleUrl: "https://a.example/1", comparisonUrl: "https://b.example/2", now: start + 120_000 }), null);
});

test("a learned rejection clears the duplicate flag and is marked as human-checked", () => {
  const feedback = storeWith();
  feedback.record({ articleUrl: "https://a.example/1", comparisonUrl: "https://b.example/2", decision: "distinct" });
  const lookup = feedbackLookupFrom(feedback);
  const candidates = [
    { url: "https://b.example/2", incomingUrl: "https://a.example/1", score: 0.95, isDuplicate: true },
  ];
  const { candidates: resolved, hits } = applyLearnedFeedback(candidates, lookup);
  assert.equal(hits.length, 1);
  assert.equal(resolved[0].isDuplicate, false);
  assert.equal(resolved[0].humanVerified, true);
  assert.equal(resolved[0].similarityBasis, "human_feedback");
  assert.match(resolved[0].similarityZone, /DEJA VERIFICAT/);
});

test("a learned confirmation keeps the article held", () => {
  const feedback = storeWith();
  feedback.record({ articleUrl: "https://a.example/1", comparisonUrl: "https://b.example/2", decision: "same_story" });
  const lookup = feedbackLookupFrom(feedback);
  const { candidates: resolved } = applyLearnedFeedback(
    [{ url: "https://b.example/2", incomingUrl: "https://a.example/1", score: 0.61, isDuplicate: false }],
    lookup
  );
  assert.equal(resolved[0].isDuplicate, true);
  assert.equal(resolved[0].humanVerified, true);
  assert.match(resolved[0].similarityZone, /DEJA VERIFICAT/);
});

test("candidates without a recorded decision are left untouched", () => {
  const feedback = storeWith();
  const { candidates: resolved, hits } = applyLearnedFeedback(
    [{ url: "https://c.example/3", incomingUrl: "https://a.example/1", score: 0.9, isDuplicate: true }],
    feedbackLookupFrom(feedback)
  );
  assert.equal(hits.length, 0);
  assert.equal(resolved[0].isDuplicate, true);
  assert.equal(resolved[0].humanVerified, undefined);
});
