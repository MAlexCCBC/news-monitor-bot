import axios from "axios";

// Citim cheia DINAMIC, in momentul apelului (nu la import): index.js ruleaza
// dotenv.config() dupa ce modulele sunt deja importate (ESM hoisting), deci la
// nivel de modul GEMINI_API_KEY ar fi inca undefined.
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;

// Modele de embedding: gemini-embedding-001 este stabil cu vectori de 768 dimensiuni.
// gemini-embedding-2 este fallback cu outputDimensionality setat.
const EMBEDDING_MODELS = ["gemini-embedding-001", "gemini-embedding-2"];
const ARTICLE_EMBEDDING_VERSION_PREFIX = "article-full-v1:";
const ARTICLE_CHUNK_CHARS = 1800;

async function getEmbedding(text) {
  let lastError;
  for (const model of EMBEDDING_MODELS) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
        {
          content: { parts: [{ text: text.slice(0, 8000) }] },
          outputDimensionality: 768,
        },
        {
          timeout: 30000,
          headers: {
            "x-goog-api-key": GEMINI_KEY(),
            "Content-Type": "application/json",
          },
        }
      );
      return res.data.embedding.values;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const detail = err.response?.data?.error?.message || err.message;
      console.warn(`[embedding] ${model} a esuat (status ${status}: ${detail}), incerc urmatorul model...`);
      continue;
    }
  }
  throw new Error(`Toate modelele de embedding au esuat: ${lastError?.message}`);
}

// Folosit pentru a păstra articolele procesate manual în istoricul comparabil,
// fără a rula sau aplica un verdict de similaritate în procesarea curentă.
export async function createNewsEmbedding(text) {
  return getEmbedding(text);
}

export function splitArticleContent(content, maxChars = ARTICLE_CHUNK_CHARS) {
  const text = String(content || "");
  if (!text.trim()) return [""];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(" ", end);
      if (boundary > start + Math.floor(maxChars * 0.6)) end = boundary;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
    while (text[start] === " ") start++;
  }
  return chunks.filter(Boolean);
}

async function embedArticleChunks(chunks, preferredModel) {
  let lastError;
  const models = preferredModel
    ? [preferredModel, ...EMBEDDING_MODELS.filter((model) => model !== preferredModel)]
    : EMBEDDING_MODELS;
  for (const model of models) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
        {
          requests: chunks.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            outputDimensionality: 768,
          })),
        },
        {
          timeout: 30000,
          headers: {
            "x-goog-api-key": GEMINI_KEY(),
            "Content-Type": "application/json",
          },
        }
      );
      return { embeddings: response.data.embeddings.map((item) => item.values), model };
    } catch (err) {
      lastError = err;
      console.warn(`[embedding] Batch ${model} a esuat (status ${err.response?.status}: ${err.response?.data?.error?.message || err.message}), incerc urmatorul model...`);
    }
  }
  throw new Error(`Toate modelele de embedding au esuat: ${lastError?.message}`);
}

function averageEmbeddings(embeddings) {
  const valid = embeddings.filter((embedding) => Array.isArray(embedding) && embedding.length);
  if (!valid.length) return [];
  const length = valid[0].length;
  const average = Array(length).fill(0);
  for (const embedding of valid) {
    for (let index = 0; index < length; index++) average[index] += embedding[index] / valid.length;
  }
  return average;
}

// Un embedding unic pentru articolul complet: Gemini primește fragmente sub
// limita de tokeni, într-un singur batch, iar vectorii sunt agregați într-o
// amprentă comparabilă. Repetăm titlul în fiecare fragment pentru context.
async function embedArticles(articles, preferredModel) {
  const articleInputs = articles.map(({ title, content }) => {
    const chunks = splitArticleContent(content);
    return chunks.map((chunk, index) =>
      `Titlu: ${title || ""}\nFragment ${index + 1}/${chunks.length}: ${chunk}`
    );
  });
  const flatInputs = articleInputs.flat();
  const { embeddings, model } = await embedArticleChunks(flatInputs, preferredModel);
  let offset = 0;
  const results = articleInputs.map((inputs) => {
    const vector = averageEmbeddings(embeddings.slice(offset, offset + inputs.length));
    offset += inputs.length;
    return vector;
  });
  return { embeddings: results, model, version: `${ARTICLE_EMBEDDING_VERSION_PREFIX}${model}` };
}

export async function createArticleEmbedding(title, content) {
  const result = await embedArticles([{ title, content }]);
  return { embedding: result.embeddings[0], embeddingModel: result.model, embeddingVersion: result.version };
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const STOP_WORDS = new Set([
  "care", "este", "sunt", "pentru", "acest", "aceasta", "aceste", "acestia",
  "dintre", "dupa", "pana", "cand", "unde", "cum", "fost", "avut", "face",
  "poate", "prin", "intre", "catre", "fara", "mult", "mai", "tot", "toate",
  "asupra", "despre", "decat", "doar", "insa", "daca", "fiind", "avand",
  "intr", "dintr", "printr", "intr-un", "intr-o", "dintr-un", "dintr-o", "sau"
]);

// Termeni editoriali foarte frecvenți care creează suprapuneri artificiale
// între titluri despre subiecte diferite.
const GENERIC_TITLE_WORDS = new Set([
  "romania", "romaniei", "roman", "romani", "politica", "politic", "politice",
  "guvern", "guvernul", "ministru", "ministrul", "minister", "ministerul",
  "presedinte", "presedintele", "parlament", "parlamentul", "declaratie",
  "declaratii", "anunta", "anuntat", "anuntă", "spune", "afirma", "dupa",
  "azi", "astazi", "nou", "noua", "noi", "oficial",
]);
const GENERIC_TITLE_STEMS = new Set([...GENERIC_TITLE_WORDS].map(stemRo));

function stemRo(word) {
  let w = word.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (w.length <= 3) return w;
  return w
    .replace(/(ului|ilor|elor|uril|area|irea|atui|itel)$/g, "")
    .replace(/(eaza|este|esc|asera|isera|aseram|iseram|urile|ului|ilor|elor|ari|iri)$/g, "")
    .replace(/(uri|ele|ate|ite|ati|iti|ind|and|tor|are|ire|ului|ul|ea|ia|ii|ei|ui)$/g, "")
    .replace(/([aeiou])$/g, "");
}

function getStems(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .map(stemRo)
    .filter((w) => !GENERIC_TITLE_STEMS.has(w));
}

const GENERIC_PROPER_NOUNS = new Set([
  "romania", "romaniei", "guvern", "guvernul", "premier", "premierul", "interimar",
  "bucuresti", "oficial", "declarat", "potrivit", "agerpres", "foto", "sursa",
  "ministru", "minister", "parlament", "senat", "camera", "deputatilor", "ziua", "marti", "miercuri", "joi", "vineri"
]);

function extractEntities(text) {
  if (!text) return { properNouns: new Set(), numbers: new Set() };
  const properMatches = text.match(/\b[A-ZĂÎÂȘȚ][a-zăîâșțA-ZĂÎÂȘȚ0-9_-]+\b/g) || [];
  const properNouns = new Set(
    properMatches
      .map((w) => w.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !GENERIC_PROPER_NOUNS.has(w))
  );

  const numMatches = text.match(/\b\d+([.,]\d+)?\b/g) || [];
  // Ani precum 2025/2026 sunt frecvenți în știri diferite și nu reprezintă
  // singuri o amprentă de eveniment; îi excludem din ancorele numerice.
  const numbers = new Set(numMatches.filter((value) => {
    if (!/^\d{4}$/.test(value)) return true;
    const year = Number(value);
    return year < 1900 || year > 2099;
  }));

  return { properNouns, numbers };
}

function titleWordOverlap(titleA, titleB) {
  const stemsA = getStems(titleA);
  const stemsB = getStems(titleB);
  if (stemsA.length === 0 || stemsB.length === 0) return 0;
  const setA = new Set(stemsA);
  const setB = new Set(stemsB);
  let common = 0;
  for (const s of setA) if (setB.has(s)) common++;
  const minSize = Math.min(setA.size, setB.size);
  return minSize > 0 ? common / minSize : 0;
}

function checkKeyEntitiesMatch(titleA, leadA, titleOld, leadOld) {
  const entA = extractEntities(`${titleA}. ${leadA}`);
  const entB = extractEntities(`${titleOld}. ${leadOld}`);

  let commonProper = 0;
  for (const p of entA.properNouns) {
    if (entB.properNouns.has(p)) commonProper++;
  }

  let commonNumbers = 0;
  for (const n of entA.numbers) {
    if (entB.numbers.has(n)) commonNumbers++;
  }

  const titleOverlap = titleWordOverlap(titleA, titleOld);

  // Măsurăm subiectul pe întregul text, nu doar pe titlu. Titlul rămâne un
  // semnal suplimentar, iar numele/cifrele singure nu pot confirma un eveniment.
  const articleA = `${titleA} ${leadA}`;
  const articleB = `${titleOld} ${leadOld}`;
  const stemsA = new Set(getStems(articleA));
  const stemsB = new Set(getStems(articleB));
  const namesA = new Set([...extractEntities(articleA).properNouns].map(stemRo));
  const namesB = new Set([...extractEntities(articleB).properNouns].map(stemRo));
  let commonTopicWords = 0;
  for (const stem of stemsA) {
    if (stemsB.has(stem) && !namesA.has(stem) && !namesB.has(stem)) commonTopicWords++;
  }

  const hasMatchingEntities =
    (titleOverlap >= 0.60 && commonTopicWords >= 3) ||
    // Când titlurile sunt formulate diferit, confirmarea vine din vocabularul
    // articolului întreg, legat de cel puțin o entitate/cifră comună.
    (commonTopicWords >= 4 && (commonProper >= 1 || commonNumbers >= 1)) ||
    (titleOverlap >= 0.45 && commonTopicWords >= 3 && (commonProper >= 1 || commonNumbers >= 1));

  return {
    hasMatchingEntities,
    titleOverlap,
    commonTopicWords,
    commonProper,
    commonNumbers,
  };
}

/**
 * Arhitectura pe 3 Zone de Decizie:
 * 1. ZONA VERDE (Score >= 0.80) -> Duplicat direct
 * 2. ZONA GRI (Score in [0.74, 0.79]) -> Arbitraj pe entitati si cuvinte-cheie din titlu/articol
 *    Daca exista entitati / subiecte comune -> scorul urca la 0.82 (duplicat)
 *    Daca titlurile si actiunile sunt complet diferite -> permis direct ca stire noua
 * 3. ZONA ALBA (Score < 0.74) -> Stire noua / permis direct
 */
export function evaluate3ZoneSimilarity(embSim, titleNew, leadNew, titleOld, leadOld, threshold = 0.80) {
  const match = checkKeyEntitiesMatch(titleNew, leadNew, titleOld, leadOld);

  // 1. ZONA VERDE (Score >= 0.80) -> Duplicat direct
  if (embSim >= threshold) {
    // Un scor semantic mare nu e suficient dacă titlurile nu confirmă același
    // subiect: știrile din aceeași zi/despre aceeași persoană pot avea embedding-uri apropiate.
    if (!match.hasMatchingEntities) {
      return {
        isDuplicate: false,
        score: embSim * 0.75,
        zone: "VERDE (Permis - Fără ancoră tematică)",
        reason: "Scorul semantic nu este susținut de termeni tematici comuni în titlu",
      };
    }
    return {
      isDuplicate: true,
      score: embSim,
      zone: "VERDE",
      reason: "Semantic embedding >= 0.80",
    };
  }

  // 2. ZONA GRI (Score intre 0.74 si prag) -> Arbitraj pe entitati / cuvinte cheie
  if (embSim >= 0.74 && embSim < threshold) {
    if (match.hasMatchingEntities) {
      return {
        isDuplicate: true,
        score: embSim,
        zone: "GRI (Duplicat confirmat)",
        reason: `Subiect/entitati comune (overlap titlu ${(match.titleOverlap * 100).toFixed(0)}%, ${match.commonProper} nume, ${match.commonNumbers} numere)`,
      };
    } else {
      return {
        isDuplicate: false,
        score: embSim,
        zone: "GRI (Permis)",
        reason: "Subiecte si entitati diferite, stire distincta din acelasi domeniu",
      };
    }
  }

  // 3. ZONA ALBA (Score < 0.74) -> Stire noua
  return {
    isDuplicate: false,
    score: embSim,
    zone: "ALBA",
    reason: "Semantic embedding < 0.74",
  };
}

// Keep the best duplicate candidate independently from the highest raw score.
// A highly semantic but title-unanchored article must not mask another, slightly
// lower-scoring candidate that passed the duplicate arbitration.
export function selectSimilarityCandidate(candidates) {
  let bestOverall = null;
  let bestDuplicate = null;
  for (const candidate of candidates) {
    if (!bestOverall || candidate.score > bestOverall.score) bestOverall = candidate;
    if (candidate.isDuplicate && (!bestDuplicate || candidate.score > bestDuplicate.score)) {
      bestDuplicate = candidate;
    }
  }
  return bestDuplicate || bestOverall || { isDuplicate: false, score: 0, url: null };
}

// Reutilizăm un embedding salvat pentru verificări de restituire/migrare fără
// apel Gemini suplimentar. `recentNewsWithEmbeddings` trebuie să excludă deja
// articolul candidat, dacă acesta a fost salvat între timp.
export function checkSimilarityEmbedding(newEmbedding, titleNew, leadNew, recentNewsWithEmbeddings, threshold = 0.80, { embeddingModel } = {}) {
  const candidates = [];
  for (const item of recentNewsWithEmbeddings) {
    if (!item.embedding || item.embedding.length === 0) continue;
    if (embeddingModel && item.embeddingModel !== embeddingModel) continue;
    // Ancora tematică folosește articolul vechi complet; embeddings-urile sunt
    // create din toate fragmentele și agregate în vectorul salvat.
    const titleOld = item.title || "";
    const leadOld = item.content || "";

    const rawSim = cosineSimilarity(newEmbedding, item.embedding);
    const evalRes = evaluate3ZoneSimilarity(rawSim, titleNew, leadNew, titleOld, leadOld, threshold);

    candidates.push({ ...evalRes, url: item.url });
  }
  const best = selectSimilarityCandidate(candidates);

  return {
    isDuplicate: best.isDuplicate,
    similarity: best.score,
    similarUrl: best.url,
    similarityZone: best.zone || null,
    similarityReason: best.reason || null,
    embedding: newEmbedding, // o salvam ca sa n-o mai calculam a doua oara
    embeddingModel,
  };
}

// Verifica dacă articolul nou e duplicat pe baza amprentelor întregului articol.
export async function checkSimilarity(newText, recentNewsWithEmbeddings, threshold = 0.80) {
  const [titleNew = "", ...leadParts] = newText.split("\n");
  const leadNew = leadParts.join("\n");
  // First compare full-article embeddings against every item in the history.
  // Titles/entities are a verdict guard, not a retrieval filter: using them to
  // select candidates here misses the same event when editors phrase headlines
  // differently.
  const comparableItems = recentNewsWithEmbeddings.filter((item) => item.embedding?.length);
  // Embed only the incoming story. Stored vectors are compared locally; never
  // re-embed history in the hot path. Gemini embedding spaces differ by model,
  // so use only vectors from the model that actually succeeded. Older records
  // without model metadata predate the fallback and are treated as primary.
  const embedded = await embedArticles([{ title: titleNew, content: leadNew }]);
  const newEmbedding = embedded.embeddings[0];
  const reembeddedNews = [];
  const compatibleItems = comparableItems.filter((item) =>
    item.embeddingModel === embedded.model || (!item.embeddingModel && embedded.model === "gemini-embedding-001")
  );
  const candidates = compatibleItems.map((item) => {
    const rawSim = cosineSimilarity(newEmbedding, item.embedding);
    const result = evaluate3ZoneSimilarity(rawSim, titleNew, leadNew, item.title || "", item.content || "", threshold);
    return { ...result, url: item.url };
  });
  const best = selectSimilarityCandidate(candidates);
  return {
    ...best,
    // Păstrăm forma de rezultat folosită de index.js și de mesajele de
    // aprobare; altfel `score/url/zone` deveneau 0% și link indisponibil.
    similarity: best.score,
    similarUrl: best.url,
    similarityZone: best.zone || null,
    similarityReason: best.reason || null,
    embedding: newEmbedding,
    embeddingModel: embedded.model,
    embeddingVersion: embedded.version,
    reembeddedNews,
  };
}
