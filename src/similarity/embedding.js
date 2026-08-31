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

function computeOverlapMetrics(textA, textB) {
  const stemsA = getStems(textA);
  const stemsB = getStems(textB);
  if (stemsA.length === 0 || stemsB.length === 0) {
    return { meanContainment: 0.5, jaccard: 0.5, minContainment: 0.5, maxContainment: 0.5, lenRatio: 1 };
  }

  const setA = new Set(stemsA);
  const setB = new Set(stemsB);

  let common = 0;
  for (const s of setA) {
    if (setB.has(s)) common++;
  }

  const union = new Set([...setA, ...setB]).size;
  const jaccard = union > 0 ? common / union : 0;
  const cA = setA.size > 0 ? common / setA.size : 0;
  const cB = setB.size > 0 ? common / setB.size : 0;
  const lenRatio = Math.min(stemsA.length, stemsB.length) / Math.max(stemsA.length, stemsB.length);

  return {
    jaccard,
    minContainment: Math.min(cA, cB),
    maxContainment: Math.max(cA, cB),
    meanContainment: (cA + cB) / 2,
    lenRatio,
  };
}

function calculateCalibratedSimilarity(textNew, textOld, embNew, embOld) {
  const embSim = cosineSimilarity(embNew, embOld);
  if (!textNew || !textOld) return embSim;

  const ov = computeOverlapMetrics(textNew, textOld);

  // Daca semantic embedding-ul este mic (< 0.70), textele sunt clar despre subiecte diferite
  if (embSim < 0.70) {
    return embSim * 0.3;
  }

  // Cand semantic embedding-ul este mare (>= 0.70):
  // 1. DUPLICATE REALE DOCUMENT COMPLET (ex. Text A vs Text B cu cele 10 prioritati):
  //    Ambii au continut partajat masiv (minContainment >= 45% sau meanContainment >= 50%) -> scor 90% - 97%.
  // 2. DUPLICATE SCURTE REFORMULATE (ex. CCR Pensii Klaus Iohannis):
  //    Lungimi comparabile (lenRatio >= 0.70) si semantica aproape identica (embSim >= 0.94) -> scor ~88% - 94%.
  // 3. STIRE NOUA / DEZVOLTARE (ex. Sinaia 1 vs Sinaia 2):
  //    Textul nou aduce mult continut inedit (minContainment <= 35% si lenRatio < 0.70) -> scor redus la ~40% - 50%.
  let finalScore;
  const isHighCoverage = ov.minContainment >= 0.45 || ov.meanContainment >= 0.50;
  const isComparableShortDuplicate = ov.lenRatio >= 0.70 && embSim >= 0.94 && ov.maxContainment >= 0.35;

  if (isHighCoverage) {
    const base = Math.max(ov.minContainment, ov.meanContainment);
    const coverageFactor = 0.90 + 0.10 * Math.min(1, (base - 0.45) / 0.35);
    finalScore = embSim * coverageFactor;
  } else if (isComparableShortDuplicate) {
    finalScore = embSim * 0.92;
  } else if (ov.minContainment <= 0.35) {
    const coverageFactor = 0.25 + 0.30 * (ov.minContainment / 0.35);
    finalScore = embSim * coverageFactor;
  } else {
    const t = (ov.minContainment - 0.35) / 0.10;
    const coverageFactor = 0.55 + 0.35 * t;
    finalScore = embSim * coverageFactor;
  }

  return Math.max(0, Math.min(1, finalScore));
}

// Verifica daca articolul nou e duplicat real (semantic + acoperire continut)
// cu vreo stire din ultimele N ore.
export async function checkSimilarity(newText, recentNewsWithEmbeddings, threshold = 0.85) {
  const newEmbedding = await getEmbedding(newText);

  let maxSimilarity = 0;
  let mostSimilarUrl = null;

  for (const item of recentNewsWithEmbeddings) {
    if (!item.embedding || item.embedding.length === 0) continue;
    const oldText = `${item.title || ""}\n${item.content || ""}`;
    const sim = calculateCalibratedSimilarity(newText, oldText, newEmbedding, item.embedding);
    if (sim > maxSimilarity) {
      maxSimilarity = sim;
      mostSimilarUrl = item.url;
    }
  }

  return {
    isDuplicate: maxSimilarity >= threshold,
    similarity: maxSimilarity,
    similarUrl: mostSimilarUrl,
    embedding: newEmbedding, // o salvam ca sa n-o mai calculam a doua oara
  };
}
