import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readArticleSimilarityHistory } from "../src/storage/article-history.js";

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
