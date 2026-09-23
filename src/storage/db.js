import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { createPendingApprovalStore } from "./pending-approvals.js";
import { createAiPostHistoryStore } from "./ai-post-history.js";
import { readArticleSimilarityHistory } from "./article-history.js";
import { sameArticleUrl } from "../utils/article-url.js";
import { ensureColumn } from "./migrations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "../../data.sqlite"));

db.pragma("journal_mode = DELETE");

db.exec(`
  CREATE TABLE IF NOT EXISTS news_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE,
    title TEXT,
    content TEXT,
    embedding TEXT, -- JSON array, stocat ca text
    embedding_model TEXT,
    embedding_version TEXT,
    created_at INTEGER NOT NULL -- unix timestamp
  );

  CREATE TABLE IF NOT EXISTS image_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_url TEXT UNIQUE,
    person_or_topic TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_model_cooldowns (
    model TEXT PRIMARY KEY,
    cooldown_until INTEGER NOT NULL,
    cooldown_version INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_news_created ON news_history(created_at);
  CREATE INDEX IF NOT EXISTS idx_image_created ON image_history(created_at);
`);

// Ignore legacy cooldowns created by the old broad quota_exceeded heuristic.
// Their exact quota window was unknown and they could suppress models that
// still had daily capacity.
ensureColumn(db, "ai_model_cooldowns", "cooldown_version", "INTEGER NOT NULL DEFAULT 1");
ensureColumn(db, "news_history", "embedding_model", "TEXT");
ensureColumn(db, "news_history", "embedding_version", "TEXT");

// Migrare: adaugam coloanele de utilizare a imaginilor la baza existenta
// (used_count = de cate ori a fost folosita imaginea, last_used = ultima folosire).
ensureColumn(db, "image_history", "used_count", "INTEGER NOT NULL DEFAULT 1");
ensureColumn(db, "image_history", "last_used", "INTEGER");
db.exec(`UPDATE image_history SET last_used = created_at WHERE last_used IS NULL`);

export function saveNews({ url, title, content, embedding, embeddingModel = null, embeddingVersion = null }) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO news_history (url, title, content, embedding, embedding_model, embedding_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(url, title, content, JSON.stringify(embedding), embeddingModel, embeddingVersion, Date.now());
}

export function saveNewsEmbedding({ url, embedding, embeddingModel, embeddingVersion }) {
  db.prepare(`
    UPDATE news_history
    SET embedding = ?, embedding_model = ?, embedding_version = ?
    WHERE url = ?
  `).run(JSON.stringify(embedding), embeddingModel, embeddingVersion, url);
}

export function getRecentNews() {
  return readArticleSimilarityHistory(db);
}

export function isUrlSeen(url) {
  const exact = db.prepare(`SELECT 1 FROM news_history WHERE url = ?`);
  if (exact.get(url)) return true;

  return db.prepare(`SELECT url FROM news_history WHERE url IS NOT NULL`).all()
    .some((row) => sameArticleUrl(row.url, url));
}

export function saveImage({ imageUrl, personOrTopic }) {
  const ts = Date.now();
  const existing = db.prepare(`SELECT id FROM image_history WHERE image_url = ?`).get(imageUrl);
  if (existing) {
    db.prepare(
      `UPDATE image_history SET used_count = used_count + 1, last_used = ? WHERE image_url = ?`
    ).run(ts, imageUrl);
  } else {
    db.prepare(
      `INSERT INTO image_history (image_url, person_or_topic, created_at, used_count, last_used)
       VALUES (?, ?, ?, 1, ?)`
    ).run(imageUrl, personOrTopic, ts, ts);
  }
}

export function getRecentImages(daysBack) {
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const stmt = db.prepare(`
    SELECT image_url, person_or_topic, used_count, last_used FROM image_history WHERE created_at >= ?
  `);
  return stmt.all(cutoff);
}

export function getActiveModelCooldowns(now = Date.now()) {
  return db.prepare(`SELECT model, cooldown_until FROM ai_model_cooldowns WHERE cooldown_until > ? AND cooldown_version = 2`).all(now);
}

export function saveModelCooldown(model, cooldownUntil) {
  db.prepare(`
    INSERT INTO ai_model_cooldowns (model, cooldown_until, cooldown_version) VALUES (?, ?, 2)
    ON CONFLICT(model) DO UPDATE SET
      cooldown_until = CASE
        WHEN ai_model_cooldowns.cooldown_version = 2 THEN MAX(ai_model_cooldowns.cooldown_until, excluded.cooldown_until)
        ELSE excluded.cooldown_until
      END,
      cooldown_version = excluded.cooldown_version
  `).run(model, cooldownUntil);
}

export function cleanupOld(hoursBack, daysBackImages) {
  const cutoffNews = Date.now() - hoursBack * 60 * 60 * 1000 * 2; // pastram 2x ca marja
  const cutoffImg = Date.now() - daysBackImages * 24 * 60 * 60 * 1000 * 2;
  db.prepare(`DELETE FROM news_history WHERE created_at < ?`).run(cutoffNews);
  db.prepare(`DELETE FROM image_history WHERE created_at < ?`).run(cutoffImg);
  db.prepare(`DELETE FROM ai_model_cooldowns WHERE cooldown_until <= ?`).run(Date.now());
}

// Forteaza scrierea completa pe disc a bazei de date (folosit inainte de a
// salva data.sqlite in git, ca sa fie salvata toata istoria, nu doar ce e
// inca in jurnalul tranzactiilor).
export function checkpointDb() {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {}
}

export default db;
export const pendingApprovals = createPendingApprovalStore(db);
const aiPostHistory = createAiPostHistoryStore(db);
export const saveAiPost = (item) => aiPostHistory.save(item);
export const getAllAiPosts = () => aiPostHistory.getAll();
