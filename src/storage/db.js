import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

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
    created_at INTEGER NOT NULL -- unix timestamp
  );

  CREATE TABLE IF NOT EXISTS image_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_url TEXT UNIQUE,
    person_or_topic TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_news_created ON news_history(created_at);
  CREATE INDEX IF NOT EXISTS idx_image_created ON image_history(created_at);
`);

// Migrare: adaugam coloanele de utilizare a imaginilor la baza existenta
// (used_count = de cate ori a fost folosita imaginea, last_used = ultima folosire).
const imgCols = db.prepare(`PRAGMA table_info(image_history)`).all().map((c) => c.name);
if (!imgCols.includes("used_count")) {
  db.exec(`ALTER TABLE image_history ADD COLUMN used_count INTEGER NOT NULL DEFAULT 1`);
}
if (!imgCols.includes("last_used")) {
  db.exec(`ALTER TABLE image_history ADD COLUMN last_used INTEGER`);
}
db.exec(`UPDATE image_history SET last_used = created_at WHERE last_used IS NULL`);

export function saveNews({ url, title, content, embedding }) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO news_history (url, title, content, embedding, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(url, title, content, JSON.stringify(embedding), Date.now());
}

export function getRecentNews(hoursBack) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const stmt = db.prepare(`
    SELECT url, title, content, embedding, created_at
    FROM news_history
    WHERE created_at >= ?
    ORDER BY created_at DESC
  `);
  return stmt.all(cutoff).map((row) => ({
    ...row,
    embedding: JSON.parse(row.embedding),
  }));
}

export function isUrlSeen(url) {
  const stmt = db.prepare(`SELECT 1 FROM news_history WHERE url = ?`);
  return !!stmt.get(url);
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

export function cleanupOld(hoursBack, daysBackImages) {
  const cutoffNews = Date.now() - hoursBack * 60 * 60 * 1000 * 2; // pastram 2x ca marja
  const cutoffImg = Date.now() - daysBackImages * 24 * 60 * 60 * 1000 * 2;
  db.prepare(`DELETE FROM news_history WHERE created_at < ?`).run(cutoffNews);
  db.prepare(`DELETE FROM image_history WHERE created_at < ?`).run(cutoffImg);
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
