import axios from "axios";

// Citim cheia DINAMIC (ESM hoisting - index.js ruleaza dotenv.config() dupa
// importurile modulelor).
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;

// Cache pentru lista de modele care exista REAL pe cheia curenta. ListModels
// e singura sursa de adevar: unele modele din dashboard nu sunt servite pe
// generateContent (ex: gemini-3-flash nu exista decat ca -preview, modelele
// 2.5 au cota mutata pe seria 3.x) si dau 404 la apel. Cu filtru dinamic,
// cascada sare automat peste ele in loc sa piarda timp pe 404-uri.
// TTL 10 minute: lista e stabila, dar o reimprospatam ocazional.
let cachedModels = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function listAvailableModels() {
  const now = Date.now();
  if (cachedModels && now - cachedAt < CACHE_TTL_MS) return cachedModels;

  try {
    const res = await axios.get("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": GEMINI_KEY() },
      timeout: 15000,
    });
    // Pastram doar modelele care suporta generateContent (excludem TTS,
    // embedding, veo etc. care apar in lista dar nu accepta acest apel).
    cachedModels = (res.data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
    cachedAt = now;
    console.log(`[models] ListModels: ${cachedModels.length} modele disponibile cu generateContent`);
  } catch (err) {
    console.warn(`[models] ListModels a esuat (${err.response?.status || err.message}) - folosesc listele configurate`);
    // Fail-open: daca nu putem lista, intoarcem null si apelantul foloseste
    // cascada configurata asa cum e (comportamentul de pana acum).
    return null;
  }
  return cachedModels;
}

// Filtreaza o cascada preferata de modele pastrand doar cele care exista pe
// cheie, IN ACEEASI ORDINE (calitate: de la cel mai bun la cel mai slab).
// Daca ListModels nu e disponibil, cascada originala ramane neatinsa.
export async function filterModels(preferred) {
  const available = await listAvailableModels();
  if (!available) return preferred;
  const filtered = preferred.filter((m) => available.includes(m));
  if (filtered.length === 0) return preferred; // nu arunca toata cascada
  return filtered;
}
