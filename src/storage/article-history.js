export const ARTICLE_HISTORY_HOURS = 24;

// One rolling window for live comparisons and restoration of pending requests.
// Old HISTORY_HOURS environment values must not silently expand it after deploy.
export function readArticleSimilarityHistory(db, now = Date.now()) {
  return db.prepare(`
    SELECT url, title, content, embedding, embedding_model, embedding_version, created_at
    FROM news_history
    WHERE created_at >= ? AND created_at <= ?
    ORDER BY created_at DESC
  `).all(now - ARTICLE_HISTORY_HOURS * 3_600_000, now).map((row) => ({
    ...row,
    embedding: row.embedding ? JSON.parse(row.embedding) : null,
    embeddingModel: row.embedding_model,
    embeddingVersion: row.embedding_version,
  }));
}
