import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "../../data.sqlite"));

db.pragma("journal_mode = WAL");

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
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO image_history (image_url, person_or_topic, created_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(imageUrl, personOrTopic, Date.now());
}

export function getRecentImages(daysBack) {
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const stmt = db.prepare(`
    SELECT image_url, person_or_topic FROM image_history WHERE created_at >= ?
  `);
  return stmt.all(cutoff);
}

export function cleanupOld(hoursBack, daysBackImages) {
  const cutoffNews = Date.now() - hoursBack * 60 * 60 * 1000 * 2; // pastram 2x ca marja
  const cutoffImg = Date.now() - daysBackImages * 24 * 60 * 60 * 1000 * 2;
  db.prepare(`DELETE FROM news_history WHERE created_at < ?`).run(cutoffNews);
  db.prepare(`DELETE FROM image_history WHERE created_at < ?`).run(cutoffImg);
}

export default db;
