import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createArticleFailureStore } from "../src/storage/article-failures.js";

test("failed article attempts are durable and replaceable without marking a story as published", () => {
  const db = new Database(":memory:");
  try {
    const failures = createArticleFailureStore(db);
    failures.save({ url: "https://example.com/story", title: "Titlu", content: "Text", draft: "Ciornă GPT", error: "GPT failed", attemptedAt: 10 });
    failures.save({ url: "https://example.com/story", title: "Titlu nou", content: "Text complet", draft: "Ciornă completă", error: "Gemini unavailable", attemptedAt: 20 });
    assert.deepEqual(failures.list(), [{
      url: "https://example.com/story", title: "Titlu nou", content: "Text complet", draft: "Ciornă completă",
      error: "Gemini unavailable", attempted_at: 20,
    }]);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'news_history'").get(), undefined);
    failures.clear("https://example.com/story");
    assert.deepEqual(failures.list(), []);
  } finally {
    db.close();
  }
});

test("failure-store migration adds draft storage to an older failure table", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE article_processing_failures (
      url TEXT PRIMARY KEY, title TEXT, content TEXT, error TEXT NOT NULL, attempted_at INTEGER NOT NULL
    )`);
    const failures = createArticleFailureStore(db);
    failures.save({ url: "https://example.com/old", error: "GPT grounding failed", draft: "Saved draft", attemptedAt: 1 });
    assert.equal(failures.list()[0].draft, "Saved draft");
  } finally {
    db.close();
  }
});
