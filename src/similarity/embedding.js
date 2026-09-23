import axios from "axios";
import { cleanArticleContent, articleFocus } from "../scraper/clean-content.js";
import { withGeminiRetries } from "../ai/gemini-client.js";

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
      const res = await withGeminiRetries(() => axios.post(
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
      ));
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
      const response = await withGeminiRetries(() => axios.post(
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
      ));
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
    const chunks = splitArticleContent(cleanArticleContent(content));
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
  if (!validVector(a) || !validVector(b) || a.length !== b.length) return 0;
  const len = a.length;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : Math.max(-1, Math.min(1, dot / denom));
}

function validVector(vector) {
  return Array.isArray(vector) && vector.length > 0 &&
    vector.every(Number.isFinite) && vector.some((value) => value !== 0);
}

function compatibleVector(newEmbedding, item, model) {
  return validVector(newEmbedding) && validVector(item.embedding) &&
    newEmbedding.length === item.embedding.length &&
    (!model || item.embeddingModel === model ||
      (!item.embeddingModel && model === "gemini-embedding-001"));
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
const LOW_SPECIFICITY_EVENT_STEMS = new Set([
  "ccr", "iccj", "sesizare", "sesizari", "conflict", "constitutional",
  "intalnire", "intalni", "intalnit", "presedinte", "presedinti", "sef", "stat",
  // Identical political actors plus generic verbs/roles often describe two
  // separate developments in the same crisis (e.g. a planned meeting vs a
  // later phone call). These terms alone cannot identify an event.
  "discut", "premier", "desemnat",
].map(stemRo));

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

function fiveWordShingles(text) {
  const words = normalizedText(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter(Boolean);
  const shingles = new Set();
  for (let index = 0; index <= words.length - 5; index++) {
    shingles.add(words.slice(index, index + 5).join(" "));
  }
  return shingles;
}

function fullArticlePhraseCoverage(titleA, bodyA, titleB, bodyB) {
  const shinglesA = fiveWordShingles(`${titleA}\n${cleanArticleContent(bodyA)}`);
  const shinglesB = fiveWordShingles(`${titleB}\n${cleanArticleContent(bodyB)}`);
  if (Math.min(shinglesA.size, shinglesB.size) < 30) return 0;
  const smaller = shinglesA.size <= shinglesB.size ? shinglesA : shinglesB;
  const larger = smaller === shinglesA ? shinglesB : shinglesA;
  let common = 0;
  for (const phrase of smaller) if (larger.has(phrase)) common++;
  return common / smaller.size;
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

function normalizedText(text = "") {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function isEditorial(title, body) {
  return /^(?:opinie|editorial)\b/i.test(normalizedText(title).trim()) ||
    /^coordonator editorial\b/i.test(normalizedText(body).trim());
}

function statementSpeaker(title, body) {
  const text = normalizedText(`${title}\n${articleFocus(body, title)}`);
  if (!/\b(?:declar\w*|spun\w*|afirm\w*|reaction\w*|intrebat\w*|mesaj\w*|consider\w*|sustin\w*|vorbit|coment\w*|interviu)\b/i.test(text)) return null;
  const headline = normalizedText(title).replace(/^(?:(?:video|exclusiv|interviu|stenograme)[\s:.\-]*)+/i, "");
  const roles = new Set(["presedintele", "presedinta", "premierul", "ministrul", "liderul", "senatorul", "vicepresedintele"]);
  const organizations = new Set(["republica", "consiliul", "uniunea", "partidul", "comisia", "curtea", "tribunalul", "biroul", "banca"]);
  // Only explicit headline names count: a name mentioned in the background
  // may be a third party, not the person whose reaction is being reported.
  for (const name of headline.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/g) || []) {
    const parts = name.toLowerCase().split(/\s+/);
    if (roles.has(parts[0])) parts.shift();
    if (parts.length >= 2 && !organizations.has(parts[0])) return parts.join(" ");
  }
  return null;
}

export function checkKeyEntitiesMatch(titleA, leadA, titleOld, leadOld) {
  leadA = cleanArticleContent(leadA);
  leadOld = cleanArticleContent(leadOld);
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

  // Măsurăm atât ancora din titlu, cât și suprapunerea subiectului în corp.
  // Aceeași persoană/loc/zi și un subiect larg (ex. copii + tehnologie sau
  // vizita la New York) nu înseamnă aceeași știre.
  const articleA = `${titleA} ${leadA}`;
  const articleB = `${titleOld} ${leadOld}`;
  const stemsA = new Set(getStems(articleA));
  const stemsB = new Set(getStems(articleB));
  const namesA = new Set([...extractEntities(articleA).properNouns].map(stemRo));
  const namesB = new Set([...extractEntities(articleB).properNouns].map(stemRo));
  const titleStemsA = new Set(getStems(titleA));
  const titleStemsB = new Set(getStems(titleOld));
  const titleNamesA = new Set([...extractEntities(titleA).properNouns].map(stemRo));
  const titleNamesB = new Set([...extractEntities(titleOld).properNouns].map(stemRo));
  let commonTopicWords = 0;
  for (const stem of stemsA) {
    if (stemsB.has(stem) && !namesA.has(stem) && !namesB.has(stem)) commonTopicWords++;
  }
  let commonTitleTopicWords = 0;
  for (const stem of titleStemsA) {
    if (titleStemsB.has(stem) && !titleNamesA.has(stem) && !titleNamesB.has(stem) &&
        !LOW_SPECIFICITY_EVENT_STEMS.has(stem)) commonTitleTopicWords++;
  }
  const titleEntitiesA = extractEntities(titleA);
  const titleEntitiesB = extractEntities(titleOld);
  const commonTitleEntities = [...titleEntitiesA.properNouns].filter((name) => titleEntitiesB.properNouns.has(name)).length;
  const commonTitleNumbers = [...titleEntitiesA.numbers].filter((number) => titleEntitiesB.numbers.has(number)).length;
  const topicCountA = [...stemsA].filter((stem) => !namesA.has(stem) && !namesB.has(stem)).length;
  const topicCountB = [...stemsB].filter((stem) => !namesA.has(stem) && !namesB.has(stem)).length;
  const bodyTopicOverlap = commonTopicWords / Math.max(1, Math.min(topicCountA, topicCountB));
  // Use only the first two substantive paragraphs as the event-focus guard;
  // a shared background section later in two unrelated articles must not
  // override their different opening developments.
  const focusA = new Set(getStems(articleFocus(leadA, titleA)).filter((s) => !namesA.has(s) && !namesB.has(s)));
  const focusB = new Set(getStems(articleFocus(leadOld, titleOld)).filter((s) => !namesA.has(s) && !namesB.has(s)));
  const commonFocusWords = [...focusA].filter((s) => focusB.has(s)).length;
  const focusTopicOverlap = commonFocusWords / Math.max(1, Math.min(focusA.size, focusB.size));
  const phraseCoverage = fullArticlePhraseCoverage(titleA, leadA, titleOld, leadOld);

  const hasMatchingEntities =
    // Ancora de persoană/cifră trebuie să apară chiar în titluri, nu doar în
    // contextul copiat în corp (care poate menționa aceiași politicieni).
    (titleOverlap >= 0.60 && commonTitleTopicWords >= 2 && (commonTitleEntities >= 1 || commonTitleNumbers >= 1)) ||
    (titleOverlap >= 0.45 && commonTitleTopicWords >= 4 && (commonTitleEntities >= 1 || commonTitleNumbers >= 1)) ||
    // Titlurile pot fi diferite pentru aceeași relatare; atunci dovada trebuie
    // să vină din primul text editorial real, după eliminarea metadata site-ului.
    (commonTopicWords >= 8 && bodyTopicOverlap >= 0.35 &&
      commonFocusWords >= 6 && focusTopicOverlap >= 0.35);

  return {
    hasMatchingEntities,
    titleOverlap,
    commonTitleTopicWords,
    bodyTopicOverlap,
    commonTopicWords,
    commonFocusWords,
    focusTopicOverlap,
    phraseCoverage,
    commonTitleEntities,
    commonTitleNumbers,
    commonProper,
    commonNumbers,
  };
}

/**
 * Arhitectura pe 3 Zone de Decizie:
 * 1. ZONA VERDE (Score >= 0.80) -> Duplicat direct
 * 2. ZONA GRI (Score in [0.74, 0.79]) -> Arbitraj pe entitati si cuvinte-cheie din titlu/articol
 *    Daca exista dovezi ale aceluiasi eveniment -> duplicat, pastrand scorul real
 *    Daca titlurile si actiunile sunt complet diferite -> permis direct ca stire noua
 * 3. ZONA ALBA (Score < 0.74) -> Stire noua / permis direct
 */
export function evaluate3ZoneSimilarity(embSim, titleNew, leadNew, titleOld, leadOld, threshold = 0.80) {
  // An exact, nontrivial article body is evidence even without named people.
  // Preserve accents/punctuation here: normalization must not erase negation.
  const bodyNew = cleanArticleContent(leadNew).toLowerCase();
  const bodyOld = cleanArticleContent(leadOld).toLowerCase();
  if (isEditorial(titleNew, bodyNew) !== isEditorial(titleOld, bodyOld)) {
    return { isDuplicate: false, score: embSim, zone: "Permis - editorial distinct",
      reason: "Un editorial poate cita declarațiile știrii fără să fie aceeași relatare" };
  }
  if (embSim >= threshold && bodyNew.length >= 120 && bodyNew === bodyOld) {
    return { isDuplicate: true, score: embSim, zone: "VERDE", reason: "Corp integral identic" };
  }
  const match = checkKeyEntitiesMatch(titleNew, leadNew, titleOld, leadOld);
  const speakerNew = statementSpeaker(titleNew, leadNew);
  const speakerOld = statementSpeaker(titleOld, leadOld);
  if (match.commonTitleTopicWords < 3 && speakerNew && speakerOld && speakerNew !== speakerOld &&
      !normalizedText(titleOld).toLowerCase().includes(speakerNew) &&
      !normalizedText(titleNew).toLowerCase().includes(speakerOld)) {
    return { isDuplicate: false, score: embSim, zone: "Permis - declarații distincte",
      reason: "Reacții ale unor vorbitori diferiți, fără suficiente detalii comune despre același eveniment" };
  }
  // Când titlurile sunt formulate diferit, acceptăm drept ancoră o potrivire
  // puternică în corpurile complete. Pragul semantic suplimentar, minimum 6
  // termeni tematici comuni, overlap minim, titlu tematic și două entități reduc riscul ca
  // simpla acoperire a aceleiași persoane/subiect larg să unească evenimente.
  const strongArticleMatch =
    embSim >= threshold + 0.04 &&
    ((match.commonTopicWords >= 5 &&
      match.bodyTopicOverlap >= 0.18 &&
      match.commonTitleTopicWords >= 4 &&
      match.commonProper >= 2) ||
      // Some outlets copy large chunks of the same wire/reporting while the
      // headline is entirely different (or one story is inside a roundup).
      // Require high phrase coverage of the shorter full article plus a strong
      // topic/focus signal; raw semantic similarity alone remains insufficient.
      (match.commonTopicWords >= 50 &&
        match.bodyTopicOverlap >= 0.60 &&
        match.commonFocusWords >= 10 &&
        match.phraseCoverage >= 0.70));

  // 1. ZONA VERDE (Score >= 0.80) -> Duplicat direct
  if (embSim >= threshold) {
    // Un scor semantic mare nu e suficient dacă titlurile nu confirmă același
    // subiect: știrile din aceeași zi/despre aceeași persoană pot avea embedding-uri apropiate.
    if (!match.hasMatchingEntities && !strongArticleMatch) {
      return {
        isDuplicate: false,
        score: embSim,
        zone: "VERDE (Permis - Fără ancoră tematică)",
        reason: "Apropiere semantică fără suficiente dovezi ale aceluiași eveniment în titlu și articol",
      };
    }
    return {
      isDuplicate: true,
      score: embSim,
      zone: "VERDE",
      reason: `Scor semantic >= ${threshold}; eveniment confirmat prin text`,
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
    if (!compatibleVector(newEmbedding, item, embeddingModel)) continue;
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
  const compatibleItems = comparableItems.filter((item) => compatibleVector(newEmbedding, item, embedded.model));
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
