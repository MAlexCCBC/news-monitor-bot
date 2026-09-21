export function createAiPostHistoryStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_post_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      embedding TEXT,
      embedding_model TEXT,
      embedding_version TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_post_created ON ai_post_history(created_at);
  `);
  const columns = db.prepare("PRAGMA table_info(ai_post_history)").all().map((column) => column.name);
  if (!columns.includes("embedding_model")) db.exec("ALTER TABLE ai_post_history ADD COLUMN embedding_model TEXT");
  if (!columns.includes("embedding_version")) db.exec("ALTER TABLE ai_post_history ADD COLUMN embedding_version TEXT");

  return {
    save({ url, title, content, embedding, embeddingModel = null, embeddingVersion = null, createdAt }) {
      db.prepare(`
        INSERT INTO ai_post_history (url, title, content, embedding, embedding_model, embedding_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          title = excluded.title,
          content = excluded.content,
          embedding = excluded.embedding,
          embedding_model = excluded.embedding_model,
          embedding_version = excluded.embedding_version,
          created_at = excluded.created_at
      `).run(url, title, content, JSON.stringify(embedding), embeddingModel, embeddingVersion, createdAt ?? Date.now());
    },

    getAll() {
      return db.prepare(`
        SELECT url, title, content, embedding, embedding_model, embedding_version, created_at
        FROM ai_post_history
        ORDER BY created_at DESC
      `).all().map((row) => ({
        ...row,
        embedding: row.embedding ? JSON.parse(row.embedding) : null,
        embeddingModel: row.embedding_model,
        embeddingVersion: row.embedding_version,
      }));
    },
  };
}
