import axios from "axios";
import { getActiveModelCooldowns, saveModelCooldown } from "../storage/db.js";

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
// Persist across GitHub Actions runner restarts via the restored SQLite data branch.
const modelCooldowns = new Map(getActiveModelCooldowns().map(({ model, cooldown_until: until }) => [model, until]));
const modelRequestTimes = new Map();
// Plafon local conservator, cu marjă față de RPM-ul observat în AI Studio.
// Aliasurile latest primesc același plafon ca familia lor ca să nu ocolească
// accidental protecția dacă Google le mută pe altă versiune.
const MODEL_RPM_BUDGETS = new Map([
  ["gemini-3.8-flash", 4], ["gemini-flash-latest", 4],
  ["gemini-3.7-flash", 4], ["gemini-3.6-flash", 4], ["gemini-3.5-flash", 4],
  ["gemini-3.5-flash-lite", 12], ["gemini-3.1-flash-lite", 12], ["gemini-flash-lite-latest", 12],
  ["gemma-4-31b-it", 24], ["gemma-4-26b-a4b-it", 24],
]);

function retryAfterMs(err, now) {
  const headers = err.response?.headers;
  const header = headers?.get?.("retry-after") ?? headers?.["retry-after"];
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }

  const details = err.response?.data?.error?.details || [];
  const retryInfo = details.find((detail) => String(detail["@type"] || "").endsWith("google.rpc.RetryInfo"));
  const delay = retryInfo?.retryDelay || details.find((detail) => detail.retryDelay)?.retryDelay;
  const match = typeof delay === "string" && delay.match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Number(match[1]) * 1000 : null;
}

export function describeGeminiError(err) {
  const apiError = err?.response?.data?.error;
  const message = apiError?.message || err?.message || "eroare necunoscută";
  const status = err?.response?.status;
  const reason = apiError?.status || apiError?.code;
  return [status ? `HTTP ${status}` : null, reason, message].filter(Boolean).join(": ");
}

// Rate limits and transient service outages are model-specific. Cache them
// across all Gemini call sites so the next article won't repeat the same error.
export function recordModelFailure(model, err, now = Date.now()) {
  const status = err?.response?.status;
  if (status !== 429 && status !== 500 && status !== 503) return false;
  const serverDelay = retryAfterMs(err, now);
  const quotaDetails = JSON.stringify(err?.response?.data?.error || {}).toLowerCase();
  const isDailyQuota = /per[_ ]?day|perday|daily|requestsperday|quota_exceeded/.test(quotaDetails);
  const isMinuteQuota = /per[_ ]?minute|perminute|rpm|requestsperminute|rate_limit_exceeded/.test(quotaDetails);
  const defaultDelay = status !== 429
    ? 60 * 1000
    : isDailyQuota
      ? 24 * 60 * 60 * 1000
      : isMinuteQuota
        ? 60 * 1000
        : 15 * 60 * 1000;
  const delay = serverDelay ?? defaultDelay;
  const cooldownUntil = Math.max(modelCooldowns.get(model) || 0, now + delay);
  modelCooldowns.set(model, cooldownUntil);
  saveModelCooldown(model, cooldownUntil);
  console.warn(`[models] ${model} în cooldown ${Math.ceil(delay / 1000)}s după HTTP ${status}`);
  return true;
}

export function filterCoolingModels(models, now = Date.now()) {
  return models.filter((model) => (modelCooldowns.get(model) || 0) <= now);
}

export function recordModelRequest(model, now = Date.now()) {
  const requests = (modelRequestTimes.get(model) || []).filter((timestamp) => now - timestamp < 60_000);
  requests.push(now);
  modelRequestTimes.set(model, requests);
}

export function filterRateLimitedModels(models, now = Date.now()) {
  return models.filter((model) => {
    const budget = MODEL_RPM_BUDGETS.get(model);
    if (!budget) return true;
    const requests = (modelRequestTimes.get(model) || []).filter((timestamp) => now - timestamp < 60_000);
    modelRequestTimes.set(model, requests);
    return requests.length < budget;
  });
}

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
  const supported = available ? preferred.filter((m) => available.includes(m)) : preferred;
  // Dacă endpointul de listare nu conține niciun nume preferat, păstrăm
  // comportamentul fail-open. Cooldown-ul nu trebuie să golească cascada.
  const configured = supported.length ? supported : preferred;
  while (true) {
    const coolingFiltered = filterCoolingModels(configured);
    if (!coolingFiltered.length) {
      console.warn(`[models] Toate modelele preferate sunt în cooldown; nu trimitem cereri care ar primi probabil încă un 429.`);
      return [];
    }
    const filtered = filterRateLimitedModels(coolingFiltered);
    if (filtered.length) {
      const skipped = configured.length - filtered.length;
      if (skipped > 0) console.log(`[models] Sărim temporar peste ${skipped} model(e) în cooldown/RPM; folosim ${filtered.join(", ")}`);
      return filtered;
    }

    const now = Date.now();
    const nextSlotAt = Math.min(...coolingFiltered.flatMap((model) => modelRequestTimes.get(model) || []).map((timestamp) => timestamp + 60_000));
    const waitMs = Math.max(1, nextSlotAt - now);
    console.log(`[models] Toate modelele din cascadă au atins temporar plafonul RPM; aștept ${Math.ceil(waitMs / 1000)}s pentru următorul slot.`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
