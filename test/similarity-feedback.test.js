import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createPendingApprovalStore } from "../src/storage/pending-approvals.js";

import { applyLearnedFeedback, createSimilarityFeedbackStore, feedbackLookupFrom, articleContentVersion } from "../src/storage/similarity-feedback.js";

const article = { title: "Știrea A", content: "Guvernul a propus o măsură." };
const comparison = { title: "Știrea B", content: "Măsura a fost discutată." };
const versions = { articleVersion: articleContentVersion(article), comparisonVersion: articleContentVersion(comparison) };
function versionedStore(db, options) {
  const store = createSimilarityFeedbackStore(db, options);
  return { ...store,
    record: (input) => store.record({ ...versions, ...input }),
    lookup: (input) => store.lookup({ ...versions, ...input }),
  };
}
function storeWith(windowMs) {
  const db = new Database(":memory:");
  return versionedStore(db, { windowMs });
}

test("legacy approve/ignore inferences are retained but cannot become semantic truth", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE similarity_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, article_url TEXT, article_title TEXT, comparison_url TEXT, decision TEXT, zone TEXT, created_at INTEGER)`);
  const now = Date.now();
  db.prepare("INSERT INTO similarity_feedback (article_url, comparison_url, decision, created_at) VALUES (?, ?, ?, ?)").run("https://a.example/1", "https://b.example/2", "same_story", now);
  const feedback = versionedStore(db);
  assert.equal(feedback.lookup({ articleUrl: "https://a.example/1", comparisonUrl: "https://b.example/2", now }), null);
  assert.deepEqual(feedback.listForArticle("https://a.example/1"), []);
  assert.equal(db.prepare("SELECT source FROM similarity_feedback").get().source, "legacy_action");
  feedback.record({ articleUrl: "https://a.example/1", comparisonUrl: "https://b.example/2", decision: "distinct", now });
  assert.equal(feedback.lookup({ articleUrl: "https://a.example/1", comparisonUrl: "https://b.example/2", now }).decision, "distinct");
  db.close();
});

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
  const lookup = feedbackLookupFrom(feedback, article);
  const candidates = [
    { url: "https://b.example/2", incomingUrl: "https://a.example/1", ...comparison, score: 0.95, isDuplicate: true },
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
  const lookup = feedbackLookupFrom(feedback, article);
  const { candidates: resolved } = applyLearnedFeedback(
    [{ url: "https://b.example/2", incomingUrl: "https://a.example/1", ...comparison, score: 0.61, isDuplicate: false }],
    lookup
  );
  assert.equal(resolved[0].isDuplicate, true);
  assert.equal(resolved[0].humanVerified, true);
  assert.match(resolved[0].similarityZone, /DEJA VERIFICAT/);
});

test("candidates without a recorded decision are left untouched", () => {
  const feedback = storeWith();
  const { candidates: resolved, hits } = applyLearnedFeedback(
    [{ url: "https://c.example/3", incomingUrl: "https://a.example/1", ...comparison, score: 0.9, isDuplicate: true }],
    feedbackLookupFrom(feedback, article)
  );
  assert.equal(hits.length, 0);
  assert.equal(resolved[0].isDuplicate, true);
  assert.equal(resolved[0].humanVerified, undefined);
});


test("feedback applies only to both exact content versions, not updated URL pairs", () => {
  const feedback = storeWith();
  feedback.record({ articleUrl: "a", comparisonUrl: "b", decision: "same_story" });
  assert.ok(feedback.lookup({ articleUrl: "a", comparisonUrl: "b" }));
  for (const field of ["articleVersion", "comparisonVersion"]) {
    assert.equal(feedback.lookup({ articleUrl: "a", comparisonUrl: "b", [field]: "updated" }), null);
    assert.equal(feedback.lookup({ articleUrl: "a", comparisonUrl: "b", [field]: null }), null);
  }
});

test("unversioned explicit decisions remain archived without overriding new comparisons", () => {
  const db = new Database(":memory:");
  const feedback = createSimilarityFeedbackStore(db);
  db.prepare("INSERT INTO similarity_feedback (article_url, comparison_url, decision, source, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("a", "b", "same_story", "explicit_similarity", Date.now());
  assert.equal(feedback.lookup({ articleUrl: "a", comparisonUrl: "b", ...versions }), null);
  assert.equal(feedback.record({ articleUrl: "a", comparisonUrl: "b", decision: "distinct" }), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM similarity_feedback").get().n, 1);
  db.close();
});

test("content versions ignore whitespace but retain new stages, numbers and headline changes", () => {
  assert.equal(articleContentVersion({ title: "Știrea  A", content: "Guvernul a propus\n o măsură." }), versions.articleVersion);
  assert.notEqual(articleContentVersion({ ...article, content: "Guvernul a adoptat o măsură." }), versions.articleVersion);
  assert.notEqual(articleContentVersion({ ...article, title: "Știrea actualizată" }), versions.articleVersion);
  assert.equal(articleContentVersion({ title: "A", content: "" }), null);
});


test("comparison content version survives durable approval serialization and claiming", () => {
  const db = new Database(":memory:");
  const pending = createPendingApprovalStore(db);
  pending.create({ id: "versioned", kind: "article", url: "a", article,
    comparisonUrl: "b", simResult: { comparisonVersion: versions.comparisonVersion },
    expiresAt: Date.now() + 60000 });
  const item = createPendingApprovalStore(db).claim("versioned");
  const feedback = createSimilarityFeedbackStore(db);
  assert.equal(feedback.record({ articleUrl: item.url, comparisonUrl: item.comparisonUrl,
    articleVersion: articleContentVersion(item.article), comparisonVersion: item.simResult.comparisonVersion,
    decision: "distinct" }), true);
  assert.equal(feedback.lookup({ articleUrl: "a", comparisonUrl: "b", ...versions }).decision, "distinct");
  db.close();
});
