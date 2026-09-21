function decode(row) {
  if (!row) return null;
  return {
    ...row,
    article: JSON.parse(row.article_json),
    simResult: JSON.parse(row.sim_result_json),
    matchedKeywords: JSON.parse(row.matched_keywords_json),
    formattedPost: row.formatted_post,
    aiEmbedding: row.ai_embedding_json ? JSON.parse(row.ai_embedding_json) : null,
  };
}

export const ARTICLE_APPROVAL_TTL_MS = 12 * 60 * 60 * 1000;

/** Durable Telegram approvals. SQLite is also restored from the data branch
 * on GitHub Actions, so callback buttons survive process restarts. */
export function createPendingApprovalStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_approvals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('article', 'ai_text')),
      url TEXT NOT NULL,
      article_json TEXT NOT NULL,
      sim_result_json TEXT NOT NULL,
      matched_keywords_json TEXT NOT NULL,
      formatted_post TEXT,
      ai_embedding_json TEXT,
      comparison_url TEXT,
      comparison_title TEXT,
      similarity REAL,
      expires_at INTEGER,
      state TEXT NOT NULL DEFAULT 'pending',
      message_id INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_state_expiry
      ON pending_approvals(state, expires_at);
  `);

  // Migrează cererile vechi pentru link-uri la noul termen de 12h. Cererile
  // expirate în ultima fereastră de 12h se reactivează și se retrimit cu
  // butoane noi; cererile ignorate sau mai vechi nu sunt reînviate.
  const migrationNow = Date.now();
  db.prepare(`
    UPDATE pending_approvals
    SET expires_at = created_at + ?, state = 'pending', message_id = NULL
    WHERE kind = 'article'
      AND state IN ('pending', 'expired')
      AND created_at >= ?
      AND expires_at < created_at + ?
  `).run(ARTICLE_APPROVAL_TTL_MS, migrationNow - ARTICLE_APPROVAL_TTL_MS, ARTICLE_APPROVAL_TTL_MS);

  const insert = db.prepare(`
    INSERT INTO pending_approvals (
      id, kind, url, article_json, sim_result_json, matched_keywords_json,
      formatted_post, ai_embedding_json, comparison_url, comparison_title,
      similarity, expires_at, state, created_at
    ) VALUES (
      @id, @kind, @url, @article_json, @sim_result_json, @matched_keywords_json,
      @formatted_post, @ai_embedding_json, @comparison_url, @comparison_title,
      @similarity, @expires_at, 'pending', @created_at
    )
  `);

  function get(id) {
    return decode(db.prepare("SELECT * FROM pending_approvals WHERE id = ?").get(id));
  }

  return {
    create(item) {
      insert.run({
        id: item.id,
        kind: item.kind,
        url: item.url,
        article_json: JSON.stringify(item.article),
        sim_result_json: JSON.stringify(item.simResult || {}),
        matched_keywords_json: JSON.stringify(item.matchedKeywords || []),
        formatted_post: item.formattedPost || null,
        ai_embedding_json: item.aiEmbedding ? JSON.stringify(item.aiEmbedding) : null,
        comparison_url: item.comparisonUrl || null,
        comparison_title: item.comparisonTitle || null,
        similarity: Number(item.similarity || 0),
        expires_at: item.expiresAt ?? null,
        created_at: item.createdAt || Date.now(),
      });
      return get(item.id);
    },

    get,

    setMessageId(id, messageId) {
      db.prepare(`UPDATE pending_approvals SET message_id = ? WHERE id = ? AND state = 'pending'`)
        .run(messageId, id);
    },

    listPending(now = Date.now()) {
      db.prepare(`UPDATE pending_approvals SET state = 'expired' WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`)
        .run(now);
      return db.prepare(`SELECT * FROM pending_approvals WHERE state = 'pending' ORDER BY created_at`)
        .all().map(decode);
    },

    claim(id, now = Date.now()) {
      const transaction = db.transaction(() => {
        const row = db.prepare("SELECT * FROM pending_approvals WHERE id = ? AND state = 'pending'").get(id);
        if (!row) return null;
        if (row.expires_at !== null && row.expires_at <= now) {
          db.prepare("UPDATE pending_approvals SET state = 'expired' WHERE id = ? AND state = 'pending'").run(id);
          return null;
        }
        const result = db.prepare("UPDATE pending_approvals SET state = 'processing' WHERE id = ? AND state = 'pending'").run(id);
        return result.changes === 1 ? decode({ ...row, state: 'processing' }) : null;
      });
      return transaction();
    },

    expire(id, now = Date.now()) {
      const row = get(id);
      if (!row || row.state !== 'pending' || row.expires_at === null || row.expires_at > now) return null;
      db.prepare("UPDATE pending_approvals SET state = 'expired' WHERE id = ? AND state = 'pending'").run(id);
      return { ...row, state: 'expired' };
    },

    setState(id, state) {
      if (!["pending", "processing", "done", "ignored", "expired"].includes(state)) {
        throw new Error(`Stare de aprobare invalidă: ${state}`);
      }
      db.prepare("UPDATE pending_approvals SET state = ? WHERE id = ?").run(state, id);
    },

    recoverInterrupted() {
      db.prepare("UPDATE pending_approvals SET state = 'pending' WHERE state = 'processing'").run();
    },
  };
}
