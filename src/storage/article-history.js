import { sameArticleUrl } from "../utils/article-url.js";

export const ARTICLE_HISTORY_HOURS = 24;

export function findSeenArticle(db, url) {
  if (!url) return null;
  const exact = db.prepare(`
    SELECT id, url, title, content, embedding, embedding_model, embedding_version, created_at
    FROM news_history WHERE url = ? LIMIT 1
  `).get(url);
  if (exact) return exact;

  return db.prepare(`
    SELECT id, url, title, content, embedding, embedding_model, embedding_version, created_at
    FROM news_history WHERE url IS NOT NULL ORDER BY created_at DESC
  `).all().find((row) => sameArticleUrl(row.url, url)) || null;
}

// A successfully delivered update replaces the prior version of the same
// publisher article. Until delivery succeeds, the old version stays available
// as similarity evidence and no history is lost.
export function saveArticleHistory(db, {
  url, title, content, embedding, embeddingModel = null, embeddingVersion = null,
}, now = Date.now()) {
  const existing = findSeenArticle(db, url);
  if (existing) {
    db.prepare(`
      UPDATE news_history SET
        url = ?, title = ?, content = ?, embedding = ?, embedding_model = ?,
        embedding_version = ?, created_at = ?
      WHERE id = ?
    `).run(url, title, content, JSON.stringify(embedding), embeddingModel, embeddingVersion, now, existing.id);
    return { updated: true, id: existing.id };
  }
  const result = db.prepare(`
    INSERT INTO news_history
      (url, title, content, embedding, embedding_model, embedding_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(url, title, content, JSON.stringify(embedding), embeddingModel, embeddingVersion, now);
  return { updated: false, id: result.lastInsertRowid };
}

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

// Active approval candidates are deliberately kept separate from published
// history, but they still need to participate in duplicate retrieval. This
// prevents multiple outlets from creating multiple approval cards while the
// first report is waiting for a human decision.
export function mergePendingArticleApprovals(recentNews, pendingApprovals, now = Date.now()) {
  const cutoff = now - ARTICLE_HISTORY_HOURS * 3_600_000;
  const merged = [...recentNews];
  for (const pending of pendingApprovals) {
    if (pending.kind !== "article" || pending.state !== "pending" ||
        !Number.isFinite(pending.created_at) || pending.created_at < cutoff || pending.created_at > now ||
        (pending.expires_at != null && pending.expires_at <= now) ||
        !pending.article?.title || !pending.url) continue;

    if (merged.some((item) => sameArticleUrl(item.url, pending.url))) continue;
    const simResult = pending.simResult || {};
    merged.push({
      url: pending.url,
      title: pending.article.title,
      content: pending.article.content || "",
      embedding: simResult.embedding || null,
      embeddingModel: simResult.embeddingModel || null,
      embeddingVersion: simResult.embeddingVersion || null,
      created_at: pending.created_at,
      isPendingApproval: true,
      pendingApprovalId: pending.id,
    });
  }

  return merged.sort((left, right) => (right.created_at || 0) - (left.created_at || 0));
}
