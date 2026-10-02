import axios from "axios";
import { cleanArticleContent, articleFocus } from "../scraper/clean-content.js";
import { arbitrateSimilarity } from "./ai-arbitrator.js";
import { applyLearnedFeedback } from "../storage/similarity-feedback.js";
import { withGeminiRetries } from "../ai/gemini-client.js";
import { sameArticleUrl } from "../utils/article-url.js";

// Citim cheia DINAMIC, in momentul apelului (nu la import): index.js ruleaza
// dotenv.config() dupa ce modulele sunt deja importate (ESM hoisting), deci la
// nivel de modul GEMINI_API_KEY ar fi inca undefined.
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;

// Modele de embedding: gemini-embedding-001 este stabil cu vectori de 768 dimensiuni.
// gemini-embedding-2 este fallback cu outputDimensionality setat.
const EMBEDDING_MODELS = ["gemini-embedding-001", "gemini-embedding-2"];
const ARTICLE_EMBEDDING_VERSION_PREFIX = "article-full-v1:";
const ARTICLE_CHUNK_CHARS = 1800;

export function isSamePublisherSource(leftUrl, rightUrl) {
  try {
    const host = (value) => new URL(value).hostname.toLowerCase().replace(/^www\d*\./, "");
    return host(leftUrl) === host(rightUrl);
  } catch {
    return false;
  }
}

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
      commonFocusWords >= 6 &&
      (focusTopicOverlap >= 0.50 ||
        (focusTopicOverlap >= 0.35 && commonTitleTopicWords >= 2) ||
        phraseCoverage >= 0.70)) ||
    // If at least 70% of the shorter substantial article is copied verbatim,
    // that is direct evidence even when a roundup has a different headline.
    phraseCoverage >= 0.70;

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
 * Embeddings and lexical evidence retrieve/rank candidates only. Gemini's
 * full-text arbitration is the final duplicate verdict; unresolved positives
 * are sent for manual review rather than blocked by a vector score.
 */
export function evaluate3ZoneSimilarity(embSim, titleNew, leadNew, titleOld, leadOld, threshold = 0.80, { samePublisher = false } = {}) {
  // An exact, nontrivial article body is evidence even without named people.
  // Preserve accents/punctuation here: normalization must not erase negation.
  const bodyNew = cleanArticleContent(leadNew).toLowerCase();
  const bodyOld = cleanArticleContent(leadOld).toLowerCase();
  if (isEditorial(titleNew, bodyNew) !== isEditorial(titleOld, bodyOld)) {
    return { isDuplicate: false, score: embSim, zone: "Permis - editorial distinct",
      reason: "Un editorial poate cita declarațiile știrii fără să fie aceeași relatare" };
  }
  const effectiveThreshold = samePublisher ? Math.max(threshold, 0.97) : threshold;
  if (samePublisher && bodyNew.length >= 120 && bodyNew === bodyOld) {
    return { isDuplicate: true, score: embSim, zone: "SURSĂ IDENTICĂ", reason: "Corp integral identic de la aceeași publicație" };
  }
  if (samePublisher && embSim < effectiveThreshold) {
    return { isDuplicate: false, score: embSim, zone: "SURSĂ IDENTICĂ (prag 97%)",
      reason: "Pentru aceeași publicație, similaritatea trebuie să atingă cel puțin 97%" };
  }
  if (embSim >= effectiveThreshold && bodyNew.length >= 120 && bodyNew === bodyOld) {
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
    embSim >= effectiveThreshold + 0.04 &&
    ((match.commonTopicWords >= 5 &&
      match.bodyTopicOverlap >= 0.18 &&
      match.commonTitleTopicWords >= 4 &&
      match.commonProper >= 2) ||
      // A roundup can have a different headline while reusing a substantial
      // focused report. Require broad overlap in both complete bodies and the
      // opening focus, not merely a shared politician or crisis background.
      (match.commonTopicWords >= 30 &&
        match.bodyTopicOverlap >= 0.60 &&
        match.commonFocusWords >= 10 &&
        match.focusTopicOverlap >= 0.35) ||
      // Some outlets copy large chunks of the same wire/reporting while the
      // headline is entirely different (or one story is inside a roundup).
      // Require high phrase coverage of the shorter full article plus a strong
      // topic/focus signal; raw semantic similarity alone remains insufficient.
      (match.commonTopicWords >= 50 &&
        match.bodyTopicOverlap >= 0.60 &&
        match.commonFocusWords >= 10 &&
        match.phraseCoverage >= 0.70));

  // 1. ZONA VERDE (Score >= 0.80) -> Duplicat direct
  if (embSim >= effectiveThreshold) {
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
      reason: `Scor semantic >= ${effectiveThreshold}; eveniment confirmat prin text`,
    };
  }

  // 2. ZONA GRI (Score intre 0.74 si prag) -> Arbitraj pe entitati / cuvinte cheie
  if (embSim >= 0.74 && embSim < effectiveThreshold) {
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

// The link shown next to a "needs review" card must be an article the model
// actually compared. Falling back to the highest-scoring candidate would point
// the reader at an arbitrary article that Gemini never read, which is how a
// similarity check ends up as a meaningless side-by-side link.
function selectReviewedCandidate(candidates, reviewedUrls) {
  let best = null;
  for (const candidate of candidates) {
    if (!reviewedUrls.has(candidate.url)) continue;
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

// Keep a wider semantic net for Gemini: this is a candidate-recall threshold,
// not a duplicate threshold. Gemini still makes the final event-level call.
const AI_RETRIEVAL_FLOOR = 0.55;
// One batched Gemini request can review more candidates without spending
// additional RPD. Reserve room for lexical matches as well as embedding
// positives so a semantically similar but factually different story cannot
// crowd out the actual same-event report.
const AI_REVIEW_LIMIT = 8;

function lexicalRetrievalScore(title, content, old) {
  const evidence = checkKeyEntitiesMatch(title, content, old.title || "", old.content || "");
  const sameHeadlineFocus = evidence.titleOverlap >= 0.30 && evidence.commonTitleTopicWords >= 2 &&
    (evidence.commonTitleEntities >= 1 || evidence.commonTitleNumbers >= 1);
  const sameOpeningDevelopment = evidence.commonFocusWords >= 6 && evidence.focusTopicOverlap >= 0.30 &&
    evidence.commonTopicWords >= 8;
  if (!sameHeadlineFocus && !sameOpeningDevelopment && evidence.phraseCoverage < 0.40) return null;
  return Math.max(
    evidence.phraseCoverage,
    sameHeadlineFocus ? 0.5 + evidence.titleOverlap / 2 : 0,
    sameOpeningDevelopment ? 0.45 + evidence.focusTopicOverlap / 2 : 0,
  );
}

export function selectAiReviewCandidates(candidates) {
  const canonicalArticleCandidates = candidates
    .filter((item) => item.sameArticleIdentity)
    .sort((a, b) => (a.historyRecencyRank || 0) - (b.historyRecencyRank || 0));
  const vectorCandidates = candidates
    .filter((item) => (item.embeddingComparable &&
      (item.score >= AI_RETRIEVAL_FLOOR || item.isDuplicate) &&
      (!item.samePublisher || item.isDuplicate || item.score >= item.samePublisherThreshold)) ||
      (item.samePublisher && item.isDuplicate))
    .sort((a, b) => b.score - a.score);
  const lexicalCandidates = candidates
    // Keep lexical evidence independent of vector score. A strong vector
    // match is not a reason to omit another article whose title/opening facts
    // are a closer match to the event being reported.
    .filter((item) => Number.isFinite(item.lexicalRetrievalScore))
    .sort((a, b) => b.lexicalRetrievalScore - a.lexicalRetrievalScore);
  const selected = [];
  const selectedUrls = new Set();
  const addCandidates = (list, limit = AI_REVIEW_LIMIT) => {
    let added = 0;
    for (const candidate of list) {
      if (selected.length >= AI_REVIEW_LIMIT || added >= limit) break;
      const key = candidate.url || candidate;
      if (selectedUrls.has(key)) continue;
      selected.push(candidate);
      selectedUrls.add(key);
      added++;
    }
  };

  // Pending decisions and independent lexical matches deserve a seat even
  // when vectors rank other stories higher.
  const recentCandidates = candidates
    .filter((item) => Number.isFinite(item.historyRecencyRank))
    .sort((a, b) => a.historyRecencyRank - b.historyRecencyRank);
  const pendingCandidates = candidates
    .filter((item) => item.isPendingApproval && (item.isDuplicate || Number.isFinite(item.lexicalRetrievalScore)))
    .sort((a, b) => Number(b.isDuplicate) - Number(a.isDuplicate) ||
      (b.lexicalRetrievalScore || 0) - (a.lexicalRetrievalScore || 0) ||
      (b.score || 0) - (a.score || 0) ||
      (a.historyRecencyRank || 0) - (b.historyRecencyRank || 0));
  // A prior version at the same canonical publisher URL is the only direct
  // evidence for deciding whether an edit is a true new stage. It must not be
  // crowded out by unrelated high-vector stories in the fixed-size batch.
  addCandidates(canonicalArticleCandidates, 1);
  addCandidates(vectorCandidates.filter((item) => item.isDuplicate), 2);
  addCandidates(lexicalCandidates, 2);
  // Reserve two Gemini slots for likely matches that have not yet been
  // published. They are not part of the durable news history until approved.
  addCandidates(pendingCandidates, 2);
  addCandidates(vectorCandidates);
  addCandidates(lexicalCandidates);
  // Recent full-text articles are a recall backstop only: they fill unused
  // capacity, but never displace a candidate supported by similarity or text.
  addCandidates(recentCandidates);
  return selected;
}

export function applySimilarityAiReview(candidates, reviewedCandidates, review) {
  const reviewedCandidateUrls = new Set(reviewedCandidates.map((candidate) => candidate.url));
  if (!review?.results?.length) {
    // Embeddings retrieve likely matches; they must not make the final
    // duplicate decision when Gemini could not provide a verdict. The link
    // shown to the human still has to be a real compared article.
    const unresolved = candidates.map((candidate) => candidate.isDuplicate
      ? {
          ...candidate,
          similarityZone: "NECESITĂ VERIFICARE (Gemini indisponibil)",
          similarityReason: "Embeddingul a găsit un posibil candidat, dar Gemini nu a putut verifica dacă este același eveniment.",
          similarityBasis: candidate.embeddingComparable ? "semantic_ai" : "ai_cross_embedding",
          aiVerdict: "uncertain",
        }
      : candidate);
    const best = selectSimilarityCandidate(unresolved);
    if (best.isDuplicate && !reviewedCandidateUrls.has(best.url)) {
      const reviewed = selectReviewedCandidate(unresolved, reviewedCandidateUrls);
      if (reviewed) return { ...best, url: reviewed.url, title: reviewed.title || best.title, content: reviewed.content || best.content };
    }
    return best;
  }
  const verdictByUrl = new Map(reviewedCandidates.map((candidate, index) => [candidate.url, review.results[index]]));
  const confirmed = candidates.filter((candidate) => verdictByUrl.get(candidate.url)?.verdict === "duplicate");
  if (confirmed.length) {
    const best = confirmed.sort((a, b) => {
      if (a.isPendingApproval !== b.isPendingApproval) return a.isPendingApproval ? -1 : 1;
      if (a.embeddingComparable !== b.embeddingComparable) return a.embeddingComparable ? -1 : 1;
      return (b.score || b.lexicalRetrievalScore || 0) - (a.score || a.lexicalRetrievalScore || 0);
    })[0];
    const result = verdictByUrl.get(best.url);
    return {
      ...best,
      isDuplicate: true,
      similarityZone: best.embeddingComparable ? "AI CONFIRMAT (embedding + articol complet)" : "AI CONFIRMAT (articole complete; spații de embedding diferite)",
      similarityReason: result.reason || "Modelul AI a confirmat că articolele relatează același eveniment.",
      similarityBasis: best.embeddingComparable ? "semantic_ai" : "ai_cross_embedding",
      aiVerdict: "duplicate",
      aiSimilarityProbability: result.duplicateProbability,
      aiChecks: result.modelChecks || [],
    };
  }
  const resolved = candidates.map((candidate) => {
    const verdict = verdictByUrl.get(candidate.url);
    if (verdict?.verdict === "uncertain") {
      // A low-probability unresolved backfill is not positive duplicate evidence.
      // Preserve review for an anchored candidate, a positive model claim, or
      // missing/high probability. Do not promote an unrelated recent item.
      const lowProbability = Number.isInteger(verdict.duplicateProbability) && verdict.duplicateProbability < 50;
      const negativeOrAbstention = ["different", "new_development", "related_context", "uncertain"].includes(verdict.modelVerdict || verdict.verdict);
      const anchored = candidate.isDuplicate || candidate.sameArticleIdentity || Number.isFinite(candidate.lexicalRetrievalScore);
      if (lowProbability && negativeOrAbstention && !anchored) {
        return {
          ...candidate, isDuplicate: false,
          similarityZone: "AI NECONFIRMAT (probabilitate mică, fără ancoră de duplicat)",
          similarityReason: "Gemini estimează sub 50% duplicat, iar candidatul nu are dovezi independente de aceeași știre; nu creez o cerere manuală.",
          similarityBasis: candidate.embeddingComparable ? "semantic_ai" : "ai_cross_embedding",
          aiVerdict: "unconfirmed_low_probability",
          aiSuggestedVerdict: verdict.modelVerdict,
          aiSimilarityProbability: verdict.duplicateProbability,
          aiChecks: verdict.modelChecks || [],
        };
      }
      return {
        ...candidate,
        // Similarity gates lead to human approval, not automatic rejection.
        // Keep an ambiguous likely match visible instead of silently passing it.
        isDuplicate: true,
        similarityZone: "NECESITĂ VERIFICARE (AI incert)",
        similarityReason: verdict.reason || "Comparația AI nu a putut stabili dacă este același eveniment; verifică manual.",
        similarityBasis: candidate.embeddingComparable ? "semantic_ai" : "ai_cross_embedding",
        aiVerdict: "uncertain",
        aiSuggestedVerdict: verdict.modelVerdict,
        aiRationale: verdict.modelReason,
        aiValidationReason: verdict.reason !== verdict.modelReason ? verdict.reason : null,
        aiSimilarityProbability: verdict.duplicateProbability,
        aiChecks: verdict.modelChecks || [],
      };
    }
    if (!["different", "new_development", "related_context"].includes(verdict?.verdict)) {
      if (candidate.isDuplicate && !reviewedCandidateUrls.has(candidate.url)) {
        return {
          ...candidate,
          isDuplicate: false,
          similarityZone: "NEVERIFICAT (candidat neanalizat)",
          similarityReason: "Embeddingul a găsit un asemănător, dar Gemini nu a primit candidatul în lotul de verificare. Știrea trece mai departe.",
          similarityBasis: candidate.embeddingComparable ? "semantic_ai" : "ai_cross_embedding",
          aiVerdict: "unreviewed",
        };
      }
      return candidate;
    }
    return {
      ...candidate,
      isDuplicate: false,
      similarityZone: verdict.verdict === "new_development" ? "AI RESPINS (informație nouă)" :
        verdict.verdict === "related_context" ? "AI RESPINS (doar context comun)" : "AI RESPINS (evenimente diferite)",
      similarityReason: verdict.reason || "Modelul AI a stabilit că articolele relatează informații distincte.",
      similarityBasis: "semantic_ai",
    };
  });
  // A pair the model found ambiguous is the only reason to keep an article out
  // of the queue, and the reader has to be shown that exact pair. If the
  // ambiguous verdict belongs to a different candidate than the highest-scoring
  // one, show the compared pair instead of an unrelated article.
  const best = selectSimilarityCandidate(resolved);
  if (best.isDuplicate && best.aiVerdict === "uncertain" && !reviewedCandidateUrls.has(best.url)) {
    const reviewed = selectReviewedCandidate(resolved, reviewedCandidateUrls);
    if (reviewed) return { ...best, url: reviewed.url, title: reviewed.title || best.title, content: reviewed.content || best.content };
  }
  return best;
}

// Reutilizăm un embedding salvat pentru verificări de restituire/migrare fără
// apel Gemini suplimentar. `recentNewsWithEmbeddings` trebuie să excludă deja
// articolul candidat, dacă acesta a fost salvat între timp.
export function checkSimilarityEmbedding(newEmbedding, titleNew, leadNew, recentNewsWithEmbeddings, threshold = 0.80, { embeddingModel, incomingUrl } = {}) {
  const candidates = [];
  for (const item of recentNewsWithEmbeddings) {
    if (!compatibleVector(newEmbedding, item, embeddingModel)) continue;
    // Ancora tematică folosește articolul vechi complet; embeddings-urile sunt
    // create din toate fragmentele și agregate în vectorul salvat.
    const titleOld = item.title || "";
    const leadOld = item.content || "";

    const rawSim = cosineSimilarity(newEmbedding, item.embedding);
    const evalRes = evaluate3ZoneSimilarity(rawSim, titleNew, leadNew, titleOld, leadOld, threshold, {
      samePublisher: isSamePublisherSource(incomingUrl, item.url),
    });

    candidates.push({ ...evalRes, url: item.url });
  }
  const best = selectSimilarityCandidate(candidates);

  return {
    isDuplicate: best.isDuplicate,
    similarity: best.score,
    similarUrl: best.url,
    similarityZone: best.similarityZone || best.zone || null,
    similarityReason: best.similarityReason || best.reason || null,
    embedding: newEmbedding, // o salvam ca sa n-o mai calculam a doua oara
    embeddingModel,
  };
}

// Verifica dacă articolul nou e duplicat pe baza amprentelor întregului articol.
export async function checkSimilarity(newText, recentNewsWithEmbeddings, threshold = 0.80, incomingUrl = null, {
  arbitrate = null,
  feedbackLookup = null,
} = {}) {
  const [titleNew = "", ...leadParts] = newText.split("\n");
  const leadNew = leadParts.join("\n");
  // First compare full-article embeddings against every item in the history.
  // Titles/entities are a verdict guard, not a retrieval filter: using them to
  // select candidates here misses the same event when editors phrase headlines
  // differently.
  const historyItems = recentNewsWithEmbeddings;
  // Embed only the incoming story. Stored vectors are compared locally; never
  // re-embed history in the hot path. Gemini embedding spaces differ by model,
  // so use only vectors from the model that actually succeeded. Older records
  // without model metadata predate the fallback and are treated as primary.
  const embedded = await embedArticles([{ title: titleNew, content: leadNew }]);
  const newEmbedding = embedded.embeddings[0];
  const reembeddedNews = [];
  const compatibleItems = historyItems.filter((item) => compatibleVector(newEmbedding, item, embedded.model));
  const compatibleUrls = new Set(compatibleItems.map((item) => item.url));
  const candidates = historyItems.map((item, historyRecencyRank) => {
    const embeddingComparable = compatibleUrls.has(item.url);
    const samePublisher = isSamePublisherSource(incomingUrl, item.url);
    const sameArticleIdentity = sameArticleUrl(incomingUrl, item.url);
    const rawSim = embeddingComparable ? cosineSimilarity(newEmbedding, item.embedding) : 0;
    const result = evaluate3ZoneSimilarity(rawSim, titleNew, leadNew, item.title || "", item.content || "", threshold, {
      samePublisher,
    });
    return {
      ...result,
      url: item.url,
      incomingUrl,
      title: item.title || "",
      content: item.content || "",
      score: rawSim,
      embeddingComparable,
      samePublisher,
      sameArticleIdentity,
      historyRecencyRank,
      samePublisherThreshold: Math.max(threshold, 0.97),
      lexicalRetrievalScore: samePublisher && embeddingComparable ? null : lexicalRetrievalScore(titleNew, leadNew, item),
      isPendingApproval: item.isPendingApproval === true,
      pendingApprovalId: item.pendingApprovalId || null,
    };
  });
  // Perechile deja decise de om au prioritate: nu cheltuim un apel de model ca
  // să redescoperim o decizie pe care omul a luat-o deja, iar răspunsul lui
  // nu poate fi contrazis de o estimare statistică nouă.
  const learned = feedbackLookup ? applyLearnedFeedback(candidates, feedbackLookup) : { candidates, hits: [] };
  for (const hit of learned.hits) {
    console.log(`[similarity] Pereche deja decisă de tine (${hit.decision}): ${incomingUrl} ↔ ${hit.url}`);
  }
  const settled = learned.candidates.filter((candidate) => candidate.humanVerified);
  const openCandidates = learned.candidates.filter((candidate) => !candidate.humanVerified);
  const localBest = selectSimilarityCandidate(openCandidates);
  const reviewCandidates = selectAiReviewCandidates(openCandidates);
  if (reviewCandidates.length) {
    const retrievalSummary = reviewCandidates.map((candidate, index) => {
      const signals = [
        candidate.isDuplicate ? "embedding-positive" : null,
        candidate.embeddingComparable && candidate.score >= AI_RETRIEVAL_FLOOR ? `vector=${Math.round(candidate.score * 100)}%` : null,
        Number.isFinite(candidate.lexicalRetrievalScore) ? `text=${Math.round(candidate.lexicalRetrievalScore * 100)}%` : null,
        candidate.isPendingApproval ? "pending" : null,
        candidate.sameArticleIdentity ? "same-url-version" : null,
        !candidate.isDuplicate && !Number.isFinite(candidate.lexicalRetrievalScore) &&
          !(candidate.embeddingComparable && candidate.score >= AI_RETRIEVAL_FLOOR) ? "recent-backfill" : null,
      ].filter(Boolean).join(",");
      return `${index + 1}:${signals || "retrieved"}:${candidate.url}`;
    }).join(" | ");
    console.log(`[similarity-retrieval] ${reviewCandidates.length}/${openCandidates.length} candidați: ${retrievalSummary}`);
  }
  let best = localBest;
  if (reviewCandidates.length) {
    let review = null;
    if (arbitrate || process.env.GEMINI_API_KEY) {
      try {
        review = await (arbitrate || arbitrateSimilarity)(
          { title: titleNew, content: leadNew },
          reviewCandidates.map(({ title, content }) => ({ title, content }))
        );
      } catch (error) {
        console.warn(`[similarity-ai] Arbitraj indisponibil; candidații probabili vor necesita verificare manuală: ${error.message}`);
      }
    } else {
      console.warn("[similarity-ai] GEMINI_API_KEY lipsește; nu folosesc embeddingul ca verdict final.");
    }
    // Embeddings retrieve candidates only; Gemini decides duplicate vs. different.
    // Missing/failed AI verdicts remain visible for a human instead of blocking
    // an article based on cosine similarity alone.
    best = applySimilarityAiReview(openCandidates, reviewCandidates, review);
  }
  // O pereche confirmată de om are prioritate peste orice verdict automat.
  const verifiedDuplicate = settled.find((candidate) => candidate.isDuplicate);
  if (verifiedDuplicate) best = verifiedDuplicate;
  else if (!best.isDuplicate && settled.length) best = { ...best, url: settled[0].url, title: settled[0].title || best.title };
  return {
    ...best,
    // Păstrăm forma de rezultat folosită de index.js și de mesajele de
    // aprobare; altfel `score/url/zone` deveneau 0% și link indisponibil.
    similarity: best.score,
    similarUrl: best.url,
    similarityZone: best.similarityZone || best.zone || null,
    similarityReason: best.similarityReason || best.reason || null,
    embedding: newEmbedding,
    embeddingModel: embedded.model,
    embeddingVersion: embedded.version,
    reembeddedNews,
  };
}
