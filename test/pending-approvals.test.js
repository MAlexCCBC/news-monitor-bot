import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ARTICLE_APPROVAL_TTL_MS, createPendingApprovalStore } from "../src/storage/pending-approvals.js";
import { createAiPostHistoryStore } from "../src/storage/ai-post-history.js";

test("rechecking updates the displayed comparison without creating a second approval", () => {
  const db = new Database(":memory:");
  try {
    const store = createPendingApprovalStore(db);
    store.create({ id: "recheck", kind: "article", url: "https://example.com/current",
      article: { title: "Titlu" }, simResult: { embedding: [1, 0] },
      comparisonTitle: "Comparație veche", comparisonUrl: "https://example.com/old",
      matchedKeywords: [], expiresAt: Date.now() + ARTICLE_APPROVAL_TTL_MS });
    store.setMessageId("recheck", 123);
    store.updateComparison("recheck", { embedding: [1, 0], similarUrl: "https://example.com/actual", similarity: .91 }, "Duplicatul real");
    const restored = store.get("recheck");
    assert.equal(restored.comparisonUrl, "https://example.com/actual");
    assert.equal(restored.comparisonTitle, "Duplicatul real");
    assert.equal(restored.similarity, .91);
    assert.equal(restored.message_id, 123);
    assert.equal(store.listPending().length, 1);
  } finally { db.close(); }
});

test("saved approval survives closing and reopening SQLite, retaining its callback payload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "news-pending-"));
  const file = path.join(dir, "state.sqlite");
  const firstDb = new Database(file);
  const firstStore = createPendingApprovalStore(firstDb);
  const article = { title: "Titlu de test", content: "Conținut", fullTextForKeywordCheck: "complet" };
  firstStore.create({
    id: "article-pending",
    kind: "article",
    url: "https://example.com/stire",
    article,
    simResult: { embedding: [0.1, 0.2], similarity: 0.84, similarUrl: "https://example.com/veche" },
    matchedKeywords: ["guvern"],
    expiresAt: Date.now() + ARTICLE_APPROVAL_TTL_MS,
  });
  firstStore.setMessageId("article-pending", 1234);
  firstDb.close();

  const db = new Database(file);
  const restoredStore = createPendingApprovalStore(db);
  const restored = restoredStore.get("article-pending");
  assert.deepEqual(restored.article, article);
  assert.deepEqual(restored.simResult.embedding, [0.1, 0.2]);
  assert.deepEqual(restored.matchedKeywords, ["guvern"]);
  assert.equal(restored.message_id, 1234);
  assert.equal(restored.state, "pending");

  assert.equal(restoredStore.claim("article-pending").state, "processing");
  assert.equal(restoredStore.claim("article-pending"), null, "second click must not process twice");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("link approval remains processable for 12 hours, while AI-text approval has no time limit", () => {
  const db = new Database(":memory:");
  const store = createPendingApprovalStore(db);
  const now = 2_000_000;
  const base = {
    url: "https://example.com/stire",
    article: { title: "Titlu", content: "Text" },
    simResult: { embedding: [1] },
    matchedKeywords: [],
  };
  store.create({ ...base, id: "expires", kind: "article", expiresAt: now + ARTICLE_APPROVAL_TTL_MS, createdAt: now });
  store.create({ ...base, id: "still-valid", url: "https://example.com/alta-stire", kind: "article", expiresAt: now + ARTICLE_APPROVAL_TTL_MS, createdAt: now });
  store.create({
    ...base,
    id: "unlimited-ai",
    kind: "ai_text",
    formattedPost: "Text AI",
    aiEmbedding: [0.9],
    expiresAt: null,
    createdAt: now,
  });

  assert.equal(store.claim("still-valid", now + 11 * 60 * 60 * 1000).state, "processing");
  assert.equal(store.claim("expires", now + ARTICLE_APPROVAL_TTL_MS + 1), null);
  assert.equal(store.get("expires").state, "expired");
  assert.equal(store.claim("unlimited-ai", now + 30 * 24 * 3_600_000).formattedPost, "Text AI");
  db.close();
});

test("only one active article approval can exist per URL", () => {
  const db = new Database(":memory:");
  const store = createPendingApprovalStore(db);
  const base = {
    kind: "article",
    url: "https://example.com/duplicata",
    article: { title: "Titlu", content: "Text" },
    simResult: { similarity: 0.94 },
    matchedKeywords: [],
    expiresAt: Date.now() + ARTICLE_APPROVAL_TTL_MS,
  };

  const first = store.createOrGet({ ...base, id: "first" });
  const second = store.createOrGet({ ...base, id: "second" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.item.id, "first");
  assert.equal(store.listPending().filter((item) => item.url === base.url).length, 1);

  store.claim("first");
  const whileProcessing = store.createOrGet({ ...base, id: "third" });
  assert.equal(whileProcessing.created, false, "processing approval must also block another prompt");
  assert.equal(whileProcessing.item.id, "first");
  db.close();
});

test("changed publisher slug with the same article ID reuses the active approval", () => {
  const db = new Database(":memory:");
  const store = createPendingApprovalStore(db);
  const firstUrl = "https://www.digi24.ro/stiri/actualitate/ccr-discuta-sesizarea-lui-bolojan-3960029";
  const updatedUrl = "https://www.digi24.ro/stiri/ccr-a-amanat-sesizarea-lui-bolojan-3960029?utm_source=telegram";
  const base = {
    kind: "article",
    article: { title: "CCR discută sesizarea lui Bolojan", content: "Text" },
    simResult: { similarity: 0.95 },
    matchedKeywords: [],
    expiresAt: Date.now() + ARTICLE_APPROVAL_TTL_MS,
  };

  const first = store.createOrGet({ ...base, id: "digi-original", url: firstUrl });
  const updated = store.createOrGet({ ...base, id: "digi-updated", url: updatedUrl });
  assert.equal(first.created, true);
  assert.equal(updated.created, false);
  assert.equal(updated.item.id, "digi-original");
  assert.equal(store.findActiveByUrl(updatedUrl).id, "digi-original");
  assert.equal(store.listPending().length, 1);
  db.close();
});

test("approval prompt sends are claimed once and ambiguous crash recovery never resends a possible duplicate", () => {
  const db = new Database(":memory:");
  const store = createPendingApprovalStore(db);
  store.create({ id: "send-once", kind: "article", url: "https://example.com/send-once",
    article: { title: "Titlu", content: "Text" }, simResult: {}, matchedKeywords: [],
    expiresAt: Date.now() + ARTICLE_APPROVAL_TTL_MS });

  assert.equal(store.claimMessageSend("send-once"), true);
  assert.equal(store.claimMessageSend("send-once"), false, "concurrent handlers cannot both send a prompt");
  store.recoverInterrupted();
  assert.equal(store.get("send-once").message_send_state, "unknown");
  assert.equal(store.claimMessageSend("send-once"), false, "after restart Telegram may already have delivered it");

  store.create({ id: "normal-send", kind: "article", url: "https://example.com/normal-send",
    article: { title: "Titlu", content: "Text" }, simResult: {}, matchedKeywords: [],
    expiresAt: Date.now() + ARTICLE_APPROVAL_TTL_MS });
  assert.equal(store.claimMessageSend("normal-send"), true);
  store.setMessageId("normal-send", 4321);
  assert.equal(store.get("normal-send").message_send_state, "sent");
  assert.equal(store.claimMessageSend("normal-send"), false);
  db.close();
});

test("startup disables legacy duplicate article approvals and exposes them for Telegram cleanup", () => {
  const db = new Database(":memory:");
  createPendingApprovalStore(db);
  db.exec("DROP INDEX idx_pending_article_active_url");
  const insert = db.prepare(`
    INSERT INTO pending_approvals (
      id, kind, url, article_json, sim_result_json, matched_keywords_json,
      state, created_at
    ) VALUES (?, 'article', ?, ?, '{}', '[]', 'pending', ?)
  `);
  insert.run("older", "https://example.com/legacy-duplicate", JSON.stringify({ title: "Prima", content: "Text" }), 1);
  insert.run("duplicate", "https://example.com/legacy-duplicate", JSON.stringify({ title: "Dublură", content: "Text" }), 2);

  const restored = createPendingApprovalStore(db);
  assert.equal(restored.get("older").state, "pending");
  assert.equal(restored.get("duplicate").state, "ignored");
  assert.deepEqual(restored.getStartupDuplicates().map((item) => item.id), ["duplicate"]);
  db.close();
});

test("upgrade extends recent expired one-hour link requests to 12h and reissues their button", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "news-expiry-migration-"));
  const file = path.join(dir, "state.sqlite");
  const now = Date.now();
  const createdAt = now - 2 * 60 * 60 * 1000;
  const firstDb = new Database(file);
  const firstStore = createPendingApprovalStore(firstDb);
  firstStore.create({
    id: "legacy-link-request",
    kind: "article",
    url: "https://example.com/legacy",
    article: { title: "Articol vechi", content: "Text" },
    simResult: {},
    matchedKeywords: [],
    expiresAt: createdAt + 60 * 60 * 1000,
    createdAt,
  });
  firstStore.setMessageId("legacy-link-request", 555);
  firstStore.expire("legacy-link-request", createdAt + 60 * 60 * 1000 + 1);
  firstDb.close();

  const upgradedDb = new Database(file);
  const upgradedStore = createPendingApprovalStore(upgradedDb);
  const restored = upgradedStore.get("legacy-link-request");
  assert.equal(restored.state, "pending");
  assert.equal(restored.expires_at, createdAt + ARTICLE_APPROVAL_TTL_MS);
  assert.equal(restored.message_id, null, "a fresh Telegram message with live buttons must be sent");
  assert.equal(restored.message_send_state, "not_sent");
  assert.equal(upgradedStore.claim("legacy-link-request", createdAt + 11 * 60 * 60 * 1000).state, "processing");
  upgradedDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("interrupted in-progress approvals return to pending after restart", () => {
  const db = new Database(":memory:");
  const store = createPendingApprovalStore(db);
  store.create({
    id: "interrupted",
    kind: "ai_text",
    url: "https://example.com/stire",
    article: { title: "Titlu", content: "Text" },
    simResult: {},
    matchedKeywords: [],
    formattedPost: "Text AI",
  });
  store.claim("interrupted");
  store.recoverInterrupted();
  assert.equal(store.get("interrupted").state, "pending");
  db.close();
});

test("approved AI outputs and embeddings remain available for similarity checks without an age cutoff", () => {
  const db = new Database(":memory:");
  const history = createAiPostHistoryStore(db);
  history.save({
    url: "https://example.com/post",
    title: "Titlu",
    content: "Postarea redactată cu AI",
    embedding: [0.25, 0.75],
    embeddingModel: "gemini-embedding-001",
    embeddingVersion: "article-full-v1:gemini-embedding-001",
    createdAt: Date.now() - 10 * 365 * 24 * 60 * 60 * 1000,
  });
  const rows = history.getAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, "Postarea redactată cu AI");
  assert.deepEqual(rows[0].embedding, [0.25, 0.75]);
  assert.equal(rows[0].embeddingModel, "gemini-embedding-001");
  assert.equal(rows[0].embeddingVersion, "article-full-v1:gemini-embedding-001");
  assert.ok(rows[0].created_at < Date.now() - 9 * 365 * 24 * 60 * 60 * 1000);
  db.close();
});
