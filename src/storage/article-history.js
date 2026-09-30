import { sameArticleUrl } from "../utils/article-url.js";

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
