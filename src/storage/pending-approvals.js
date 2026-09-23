import { sameArticleUrl } from "../utils/article-url.js";

function decode(row) {
  if (!row) return null;
  return {
    ...row,
    article: JSON.parse(row.article_json),
    simResult: JSON.parse(row.sim_result_json),
    matchedKeywords: JSON.parse(row.matched_keywords_json),
    formattedPost: row.formatted_post,
    comparisonUrl: row.comparison_url,
    comparisonTitle: row.comparison_title,
    aiEmbedding: row.ai_embedding_json ? JSON.parse(row.ai_embedding_json) : null,
  };
}

export const ARTICLE_APPROVAL_TTL_MS = 12 * 60 * 60 * 1000;
const LEGACY_ARTICLE_APPROVAL_TTL_MS = 60 * 60 * 1000;

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
      message_send_state TEXT NOT NULL DEFAULT 'not_sent',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_approvals_state_expiry
      ON pending_approvals(state, expires_at);
  `);

  // Telegram sendMessage has no idempotency key. Rows that predate this state
  // and have no message_id are ambiguous after a crash; do not blindly resend
  // them, since Telegram may already have accepted the message.
  const approvalCols = db.prepare(`PRAGMA table_info(pending_approvals)`).all().map((column) => column.name);
  if (!approvalCols.includes("message_send_state")) {
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN message_send_state TEXT NOT NULL DEFAULT 'unknown'`);
  }
  db.exec(`UPDATE pending_approvals SET message_send_state = 'sent' WHERE message_id IS NOT NULL AND message_send_state <> 'sent'`);

  // Migrează cererile vechi pentru link-uri la noul termen de 12h. Cererile
  // expirate în ultima fereastră de 12h se reactivează și se retrimit cu
  // butoane noi; cererile ignorate sau mai vechi nu sunt reînviate.
  const migrationNow = Date.now();
  db.prepare(`
    UPDATE pending_approvals
    SET expires_at = created_at + ?, state = 'pending', message_id = NULL, message_send_state = 'not_sent'
    WHERE kind = 'article'
      AND state IN ('pending', 'expired')
      AND created_at >= ?
      AND expires_at <= created_at + ?
  `).run(
    ARTICLE_APPROVAL_TTL_MS,
    migrationNow - ARTICLE_APPROVAL_TTL_MS,
    LEGACY_ARTICLE_APPROVAL_TTL_MS + 60 * 1000
  );

  // Mesajele de canal se pot repeta. Păstrăm cea mai veche cerere activă
  // per URL și dezactivăm aprobările duplicate existente înainte să adăugăm
  // indexul unic pentru protecție și în cazul unei curse.
  const startupDuplicates = db.prepare(`
    SELECT * FROM pending_approvals
    WHERE kind = 'article'
      AND state IN ('pending', 'processing')
      AND rowid NOT IN (
        SELECT MIN(rowid) FROM pending_approvals
        WHERE kind = 'article' AND state IN ('pending', 'processing')
        GROUP BY url
      )
    ORDER BY created_at, rowid
  `).all().map(decode);
  for (const duplicate of startupDuplicates) {
    db.prepare(`UPDATE pending_approvals SET state = 'ignored' WHERE id = ?`).run(duplicate.id);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_article_active_url
    ON pending_approvals(url)
    WHERE kind = 'article' AND state IN ('pending', 'processing');
  `);

  const insert = db.prepare(`
    INSERT INTO pending_approvals (
      id, kind, url, article_json, sim_result_json, matched_keywords_json,
      formatted_post, ai_embedding_json, comparison_url, comparison_title,
      similarity, expires_at, state, message_send_state, created_at
    ) VALUES (
      @id, @kind, @url, @article_json, @sim_result_json, @matched_keywords_json,
      @formatted_post, @ai_embedding_json, @comparison_url, @comparison_title,
      @similarity, @expires_at, 'pending', 'not_sent', @created_at
    )
  `);

  function get(id) {
    return decode(db.prepare("SELECT * FROM pending_approvals WHERE id = ?").get(id));
  }

  const findActiveArticleUrls = db.prepare(`
    SELECT id, url FROM pending_approvals
    WHERE kind = 'article' AND state IN ('pending', 'processing')
    ORDER BY created_at, rowid
  `);
  const findExpiredArticleUrls = db.prepare(`
    SELECT id, url FROM pending_approvals
    WHERE kind = 'article' AND state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
  `);
  const expireById = db.prepare(`UPDATE pending_approvals SET state = 'expired' WHERE id = ? AND state = 'pending'`);
  const getById = db.prepare(`SELECT * FROM pending_approvals WHERE id = ?`);
  function findActiveArticleByUrl(url) {
    const match = findActiveArticleUrls.all().find((row) => sameArticleUrl(row.url, url));
    return match ? getById.get(match.id) : null;
  }
  function expireMatchingArticleUrls(url, now) {
    for (const row of findExpiredArticleUrls.all(now)) {
      if (sameArticleUrl(row.url, url)) expireById.run(row.id);
    }
  }
  const createTransaction = db.transaction((item) => {
    if (item.kind === "article") {
      expireMatchingArticleUrls(item.url, item.createdAt || Date.now());
      const existing = findActiveArticleByUrl(item.url);
      if (existing) return { item: decode(existing), created: false };
    }
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
    return { item: get(item.id), created: true };
  });

  return {
    create(item) {
      return createTransaction(item).item;
    },

    createOrGet(item) {
      return createTransaction(item);
    },

    findActiveByUrl(url, now = Date.now()) {
      expireMatchingArticleUrls(url, now);
      return decode(findActiveArticleByUrl(url));
    },

    getStartupDuplicates() {
      return startupDuplicates;
    },

    get,

    updateComparison(id, simResult, comparisonTitle) {
      db.prepare(`UPDATE pending_approvals
        SET sim_result_json = ?, comparison_url = ?, comparison_title = ?, similarity = ?
        WHERE id = ? AND state = 'pending'`)
        .run(JSON.stringify(simResult), simResult.similarUrl, comparisonTitle || null, simResult.similarity, id);
      return get(id);
    },

    setMessageId(id, messageId) {
      db.prepare(`UPDATE pending_approvals SET message_id = ?, message_send_state = 'sent' WHERE id = ? AND state = 'pending'`)
        .run(messageId, id);
    },

    claimMessageSend(id) {
      const result = db.prepare(`UPDATE pending_approvals SET message_send_state = 'sending'
        WHERE id = ? AND state = 'pending' AND message_id IS NULL AND message_send_state = 'not_sent'`).run(id);
      return result.changes === 1;
    },

    markMessageSendUncertain(id) {
      db.prepare(`UPDATE pending_approvals SET message_send_state = 'unknown'
        WHERE id = ? AND state = 'pending' AND message_id IS NULL AND message_send_state = 'sending'`).run(id);
    },

    releaseMessageSendClaim(id) {
      db.prepare(`UPDATE pending_approvals SET message_send_state = 'not_sent'
        WHERE id = ? AND state = 'pending' AND message_id IS NULL AND message_send_state = 'sending'`).run(id);
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
      db.prepare(`UPDATE pending_approvals SET message_send_state = 'unknown'
        WHERE state = 'pending' AND message_id IS NULL AND message_send_state = 'sending'`).run();
    },
  };
}
