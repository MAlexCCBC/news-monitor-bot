import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mergePendingArticleApprovals, readArticleSimilarityHistory } from "../src/storage/article-history.js";

test("article comparison window includes the 24h boundary, excludes older and future records", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE news_history (url TEXT, title TEXT, content TEXT,
      embedding TEXT, embedding_model TEXT, embedding_version TEXT, created_at INTEGER)`);
    const now = 1_800_000_000_000;
    const insert = db.prepare("INSERT INTO news_history VALUES (?, 'Titlu', 'Corp', '[1,0]', 'gemini-embedding-001', 'v1', ?)");
    insert.run("now", now);
    insert.run("boundary", now - 86_400_000);
    insert.run("too-old", now - 86_400_001);
    insert.run("future", now + 1);
    assert.deepEqual(readArticleSimilarityHistory(db, now).map((r) => r.url), ["now", "boundary"]);
    // Move the clock; eligibility changes without deleting the archive.
    assert.deepEqual(readArticleSimilarityHistory(db, now + 2).map((r) => r.url), ["future", "now"]);
    assert.equal(db.prepare("SELECT count(*) n FROM news_history").get().n, 4);
  } finally { db.close(); }
});

test("active article approvals join comparison candidates without becoming published history", () => {
  const now = 1_800_000_000_000;
  const history = [{ url: "https://hotnews.ro/publicat-123456", title: "Publicat", content: "corp", created_at: now - 100 }];
  const pending = [
    {
      id: "pending-new", kind: "article", state: "pending", url: "https://www.digi24.ro/stiri/articol-234567",
      article: { title: "În așteptare", content: "Textul integral pending" },
      simResult: { embedding: [0.5, 0.5], embeddingModel: "gemini-embedding-001", embeddingVersion: "article-full-v1" },
      created_at: now - 50, expires_at: now + 60_000,
    },
    {
      id: "pending-ai", kind: "ai_text", state: "pending", url: "https://example.com/ai",
      article: { title: "Text AI", content: "Nu este articol sursă" }, created_at: now - 25, expires_at: now + 60_000,
    },
    {
      id: "pending-expired", kind: "article", state: "pending", url: "https://example.com/expired",
      article: { title: "Expirat", content: "corp" }, created_at: now - 25, expires_at: now,
    },
    {
      id: "pending-old", kind: "article", state: "pending", url: "https://example.com/old",
      article: { title: "Vechi", content: "corp" }, created_at: now - 86_400_001, expires_at: now + 60_000,
    },
    {
      id: "pending-processed-url", kind: "article", state: "pending", url: "https://www.hotnews.ro/publicat-123456?utm_source=feed",
      article: { title: "Aceeași adresă normalizată", content: "corp" }, created_at: now - 20, expires_at: now + 60_000,
    },
  ];

  const merged = mergePendingArticleApprovals(history, pending, now);
  assert.deepEqual(merged.map((item) => item.url), [pending[0].url, history[0].url]);
  assert.deepEqual(merged[0].embedding, [0.5, 0.5]);
  assert.equal(merged[0].embeddingModel, "gemini-embedding-001");
  assert.equal(merged[0].isPendingApproval, true);
  assert.equal(merged[0].pendingApprovalId, "pending-new");
  assert.equal(history.length, 1, "published-history input remains unchanged");
});
