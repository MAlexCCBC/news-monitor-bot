import axios from "axios";

// Citim cheia DINAMIC, in momentul apelului (nu la import): index.js ruleaza
// dotenv.config() dupa ce modulele sunt deja importate (ESM hoisting), deci la
// nivel de modul GEMINI_API_KEY ar fi inca undefined.
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;

// Modele de embedding, in ordinea preferintei. gemini-embedding-2 e cel mai
// nou (multimodal), gemini-embedding-001 e varianta text-only stabila, folosita
// ca fallback. Atentie: NU "gemini-embedding-1" - numele exact conteaza pentru API.
const EMBEDDING_MODELS = ["gemini-embedding-2", "gemini-embedding-001"];

async function getEmbedding(text) {
  let lastError;
  for (const model of EMBEDDING_MODELS) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
        {
          content: { parts: [{ text: text.slice(0, 8000) }] },
        },
        {
          timeout: 15000,
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
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Verifica daca articolul nou e prea similar (inclusiv sinonime/rescrieri,
// pentru ca embeddings capteaza sensul, nu doar cuvinte identice)
// cu vreo stire din ultimele N ore.
export async function checkSimilarity(newText, recentNewsWithEmbeddings, threshold = 0.4) {
  const newEmbedding = await getEmbedding(newText);

  let maxSimilarity = 0;
  let mostSimilarUrl = null;

  for (const item of recentNewsWithEmbeddings) {
    if (!item.embedding || item.embedding.length === 0) continue;
    const sim = cosineSimilarity(newEmbedding, item.embedding);
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
