export function createArticleFailureStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS article_processing_failures (
      url TEXT PRIMARY KEY,
      title TEXT,
      content TEXT,
      draft TEXT,
      error TEXT NOT NULL,
      attempted_at INTEGER NOT NULL
    )
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(article_processing_failures)").all().map((column) => column.name));
  if (!columns.has("draft")) db.exec("ALTER TABLE article_processing_failures ADD COLUMN draft TEXT");

  const upsert = db.prepare(`
    INSERT INTO article_processing_failures (url, title, content, draft, error, attempted_at)
    VALUES (@url, @title, @content, @draft, @error, @attemptedAt)
    ON CONFLICT(url) DO UPDATE SET
      title = excluded.title,
      content = excluded.content,
      draft = excluded.draft,
      error = excluded.error,
      attempted_at = excluded.attempted_at
  `);
  const remove = db.prepare("DELETE FROM article_processing_failures WHERE url = ?");

  return {
    save({ url, title, content, draft, error, attemptedAt = Date.now() }) {
      upsert.run({ url, title: title || null, content: content || null, draft: draft || null, error: String(error || "Eroare necunoscută").slice(0, 4000), attemptedAt });
    },
    clear(url) {
      remove.run(url);
    },
    list() {
      return db.prepare("SELECT url, title, content, draft, error, attempted_at FROM article_processing_failures ORDER BY attempted_at DESC").all();
    },
  };
}
