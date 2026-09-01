import axios from "axios";

// Citim cheia DINAMIC, in momentul apelului (nu la import): index.js ruleaza
// dotenv.config() dupa ce modulele sunt deja importate (ESM hoisting), deci la
// nivel de modul GEMINI_API_KEY ar fi inca undefined.
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;

// Modele de embedding: gemini-embedding-001 este stabil cu vectori de 768 dimensiuni.
// gemini-embedding-2 este fallback cu outputDimensionality setat.
const EMBEDDING_MODELS = ["gemini-embedding-001", "gemini-embedding-2"];

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
    .map(stemRo);
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
  const numbers = new Set(numMatches);

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

  // Exista potrivire de entitati cheie daca:
  // 1. Titlurile au cuvinte/subiecte comune (titleOverlap >= 35%)
  // 2. Sau exista entitati specifice comune (ex: Rutte, CCR, 770, PNRR) plus overlap minim pe titlu
  const hasMatchingEntities =
    titleOverlap >= 0.35 ||
    (titleOverlap >= 0.20 && (commonProper >= 1 || commonNumbers >= 1)) ||
    (commonProper >= 2 && commonNumbers >= 1);

  return {
    hasMatchingEntities,
    titleOverlap,
    commonProper,
    commonNumbers,
  };
}

/**
 * Arhitectura pe 3 Zone de Decizie:
 * 1. ZONA VERDE (Score >= 0.80) -> Duplicat direct
 * 2. ZONA GRI (Score in [0.74, 0.79]) -> Arbitraj pe entitati si cuvinte cheie din titlu/lead
 *    Daca exista entitati / subiecte comune -> scorul urca la 0.82 (duplicat)
 *    Daca titlurile si actiunile sunt complet diferite -> permis direct ca stire noua
 * 3. ZONA ALBA (Score < 0.74) -> Stire noua / permis direct
 */
export function evaluate3ZoneSimilarity(embSim, titleNew, leadNew, titleOld, leadOld, threshold = 0.80) {
  const match = checkKeyEntitiesMatch(titleNew, leadNew, titleOld, leadOld);

  // 1. ZONA VERDE (Score >= 0.80) -> Duplicat direct
  if (embSim >= threshold) {
    // Protectie de siguranta: daca titlurile au 0% cuvinte comune si nicio entitate comuna,
    // semantica generica pe domeniu nu poate bloca o stire complet diferita.
    if (match.titleOverlap < 0.15 && match.commonProper === 0 && match.commonNumbers === 0) {
      return {
        isDuplicate: false,
        score: embSim * 0.75,
        zone: "VERDE (Permis - Subiecte complet diferite)",
        reason: "Zero potrivire pe titlu si entitati specifice",
      };
    }
    return {
      isDuplicate: true,
      score: embSim,
      zone: "VERDE",
      reason: "Semantic embedding >= 0.80",
    };
  }

  // 2. ZONA GRI (Score intre 0.74 si 0.79) -> Arbitraj pe entitati / cuvinte cheie
  if (embSim >= 0.74 && embSim < threshold) {
    if (match.hasMatchingEntities) {
      return {
        isDuplicate: true,
        score: Math.max(embSim, 0.82),
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

// Verifica daca articolul nou e duplicat (amprenta concentrata Titlu + Lead pe 3 zone)
export async function checkSimilarity(newText, recentNewsWithEmbeddings, threshold = 0.80) {
  const newEmbedding = await getEmbedding(newText);

  let maxSimilarity = 0;
  let isDuplicateFinal = false;
  let mostSimilarUrl = null;

  // Extragem titlul si lead-ul din textul nou
  const partsNew = newText.split("\n");
  const titleNew = partsNew[0] || "";
  const leadNew = partsNew.slice(1).join(" ") || "";

  for (const item of recentNewsWithEmbeddings) {
    if (!item.embedding || item.embedding.length === 0) continue;
    // Comparam Lead-to-Lead (primele 300 de caractere din stirea veche, nu tot corpul de 3000)
    const titleOld = item.title || "";
    const leadOld = (item.content || "").slice(0, 300);

    const rawSim = cosineSimilarity(newEmbedding, item.embedding);
    const evalRes = evaluate3ZoneSimilarity(rawSim, titleNew, leadNew, titleOld, leadOld, threshold);

    if (evalRes.score > maxSimilarity) {
      maxSimilarity = evalRes.score;
      isDuplicateFinal = evalRes.isDuplicate;
      mostSimilarUrl = item.url;
    }
  }

  return {
    isDuplicate: isDuplicateFinal,
    similarity: maxSimilarity,
    similarUrl: mostSimilarUrl,
    embedding: newEmbedding, // o salvam ca sa n-o mai calculam a doua oara
  };
}
