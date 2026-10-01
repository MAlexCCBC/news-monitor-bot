import { sameArticleUrl } from "../utils/article-url.js";

/**
 * Feedback de similaritate din deciziile umane.
 *
 * Nu putem cunoaște de acum ce știri vor apărea, deci nu există o listă de
 * excepții care să rezolve problema. Singura sursă de adevăr despre ce
 * consideră omul „aceeași știre" sunt propriile sale decizii: când aprobă o
 * cerere marcată ca posibil duplicat, perechea era de fapt distinctă (false
 * positive), iar când o ignoră, era într-adevăr aceeași știre (true positive).
 *
 * Aceste perechi se rețin și se aplică direct înaintea oricărei comparații
 * cu model, fără costuri API. Feedbackul este limitat la perechi încă
 * prezente în fereastra de istoric, ca o decizie veche să nu blocheze
 * permanent o știre nouă cu același subiect.
 */
export function createSimilarityFeedbackStore(db, { windowMs = 24 * 60 * 60 * 1000 } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS similarity_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_url TEXT NOT NULL,
      article_title TEXT,
      comparison_url TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('distinct', 'same_story')),
      zone TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_similarity_feedback_pair
      ON similarity_feedback(article_url, comparison_url);
    CREATE INDEX IF NOT EXISTS idx_similarity_feedback_created
      ON similarity_feedback(created_at);
  `);

  const insert = db.prepare(`
    INSERT INTO similarity_feedback (article_url, article_title, comparison_url, decision, zone, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  // Rândul nou este întotdeauna ultima decizie, chiar și când două acțiuni
  // umane cad în aceeași secundă: ordonăm și după id, care crește strict.
  const findExact = db.prepare(`
    SELECT decision, zone, created_at FROM similarity_feedback
    WHERE article_url = ? AND comparison_url = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `);
  const findByArticle = db.prepare(`
    SELECT comparison_url, decision, zone FROM similarity_feedback
    WHERE article_url = ? ORDER BY created_at DESC, id DESC LIMIT 50
  `);

  return {
    record({ articleUrl, articleTitle, comparisonUrl, decision, zone, now = Date.now() }) {
      if (!articleUrl || !comparisonUrl || !["distinct", "same_story"].includes(decision)) return false;
      // O pereche poate reapărea după repetarea aceleiași știri pe alt canal;
      // ultima decizie a omului este cea care contează.
      insert.run(articleUrl, articleTitle || null, comparisonUrl, decision, zone || null, now);
      return true;
    },

    // Decizia înregistrată pentru această pereche exactă, dacă e încă relevantă.
    lookup({ articleUrl, comparisonUrl, now = Date.now() }) {
      if (!articleUrl || !comparisonUrl) return null;
      const row = findExact.get(articleUrl, comparisonUrl);
      if (!row) return null;
      if (now - row.created_at > windowMs) return null;
      return row;
    },

    // Perechi învățate din același articol, pentru a evita să retrimitem cereri
    // pentru combinații pe care omul le-a soluționat deja.
    listForArticle(articleUrl) {
      if (!articleUrl) return [];
      return findByArticle.all(articleUrl);
    },

    // Curățare ca tabelul să nu crească la nesfârșit într-un bot de lungă durată.
    cleanup(now = Date.now()) {
      db.prepare(`DELETE FROM similarity_feedback WHERE created_at < ?`).run(now - windowMs * 7);
    },
  };
}

// Perechile învățate se aplică înaintea verdictului modelului, dar nu pot
// anula o corespondență evidentă: o decizie veche despre altă combinație nu
// trebuie să treacă peste o știre nouă.
export function applyLearnedFeedback(candidates, lookup) {
  const hits = [];
  const resolved = candidates.map((candidate) => {
    const learned = lookup(candidate);
    if (!learned) return candidate;
    hits.push({ url: candidate.url, decision: learned.decision });
    if (learned.decision === "same_story") {
      return {
        ...candidate,
        isDuplicate: true,
        similarityZone: "DEJA VERIFICAT DE TINE (aceeași știre)",
        similarityReason: "Ai confirmat anterior că aceste două articole sunt aceeași știre.",
        similarityBasis: "human_feedback",
        humanVerified: true,
      };
    }
    return {
      ...candidate,
      isDuplicate: false,
      similarityZone: "DEJA VERIFICAT DE TINE (știri diferite)",
      similarityReason: "Ai decis anterior că aceste două articole sunt știri diferite.",
      similarityBasis: "human_feedback",
      humanVerified: true,
    };
  });
  return { candidates: resolved, hits };
}

export function feedbackLookupFrom(feedback) {
  return (candidate) => feedback.lookup({
    articleUrl: candidate.incomingUrl,
    comparisonUrl: candidate.url,
  });
}
