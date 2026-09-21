export function createAiPostHistoryStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_post_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      embedding TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_post_created ON ai_post_history(created_at);
  `);

  return {
    save({ url, title, content, embedding }) {
      db.prepare(`
        INSERT INTO ai_post_history (url, title, content, embedding, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          embedding = excluded.embedding,
          created_at = excluded.created_at
      `).run(url, title, content, JSON.stringify(embedding), Date.now());
    },

    getRecent(hoursBack) {
      const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
      return db.prepare(`
        SELECT url, title, content, embedding, created_at
        FROM ai_post_history
        WHERE created_at >= ?
        ORDER BY created_at DESC
      `).all(cutoff).map((row) => ({
        ...row,
        embedding: row.embedding ? JSON.parse(row.embedding) : null,
      }));
    },

    deleteBefore(timestamp) {
      db.prepare("DELETE FROM ai_post_history WHERE created_at < ?").run(timestamp);
    },
  };
}
