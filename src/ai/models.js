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
  if (match) return Number(match[1]) * 1000;

  // The REST error sometimes includes its retry hint only in error.message.
  const messageDelay = err.response?.data?.error?.message?.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i);
  return messageDelay ? Number(messageDelay[1]) * 1000 : null;
}

function nextPacificMidnightDelay(now) {
  const dayInPacific = (timestamp) => new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(timestamp);
  const currentDay = dayInPacific(now);
  let nextReset = now;
  do {
    nextReset += 60_000;
  } while (dayInPacific(nextReset) === currentDay);
  return nextReset - now;
}

export function describeGeminiError(err) {
  const apiError = err?.response?.data?.error;
  const message = apiError?.message || err?.message || "eroare necunoscută";
  const status = err?.response?.status;
  const reason = apiError?.status || apiError?.code;
  return [status ? `HTTP ${status}` : null, reason, message].filter(Boolean).join(": ");
}

// Cache explicit 429/500 model failures across calls. 503 is deliberately not
// cooled down: it can be a shared transient, so the cascade should try every
// other model and subsequent articles should be allowed to retry it.
export function recordModelFailure(model, err, now = Date.now()) {
  const status = err?.response?.status;
  const isTimeout = err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT" || /timeout/i.test(err?.message || "");
  // A 503 may be a transient shared-backend incident; don't persist a
  // per-model cooldown that would hide that model from later article attempts.
  if (status !== 429 && status !== 500 && !isTimeout) return false;
  if (isTimeout) {
    const cooldownUntil = Math.max(modelCooldowns.get(model) || 0, now + 60_000);
    modelCooldowns.set(model, cooldownUntil);
    saveModelCooldown(model, cooldownUntil);
    console.warn(`[models] ${model} în cooldown 60s după timeout client`);
    return true;
  }
  const serverDelay = retryAfterMs(err, now);
  const apiError = err?.response?.data?.error || {};
  const violations = (apiError.details || []).flatMap((detail) => detail.violations || []);
  const quotaIds = violations.map((violation) => violation.quotaId || "").join(" ").toLowerCase();
  const quotaMetrics = violations.map((violation) => violation.quotaMetric || violation.quota_metric || "").join(" ").toLowerCase();
  const quotaEvidence = `${quotaMetrics} ${apiError.message || ""}`.toLowerCase();
  // Do not infer a daily lockout from generic 429 text; Google also exposes
  // the free-tier daily request metric in quota violations.
  const isDailyQuota = /per[_ ]?day|perday|requestsperday/.test(quotaIds) ||
    (/generate_content_free_tier_requests/.test(quotaEvidence) && !/generate_content_free_tier_requests[^\n]*(?:minute|second)/.test(quotaEvidence));
  const isMinuteQuota = /per[_ ]?minute|perminute|requestsperminute/.test(quotaIds);
  const defaultDelay = status !== 429 ? 60_000 : isMinuteQuota ? 60_000 : 15 * 60_000;
  const delay = isDailyQuota
    ? Math.max(serverDelay || 0, nextPacificMidnightDelay(now))
    : serverDelay ?? defaultDelay;
  const cooldownUntil = Math.max(modelCooldowns.get(model) || 0, now + delay);
  modelCooldowns.set(model, cooldownUntil);
  saveModelCooldown(model, cooldownUntil);
  console.warn(`[models] ${model} în cooldown ${Math.ceil(delay / 1000)}s după HTTP ${status}${isDailyQuota ? " (RPD confirmat de quotaId)" : ""}`);
  return true;
}

export function filterCoolingModels(models, now = Date.now()) {
  return models.filter((model) => (modelCooldowns.get(model) || 0) <= now);
}

export function eligibleModels(preferred, available, now = Date.now()) {
  const supported = available ? preferred.filter((model) => available.includes(model)) : preferred;
  // Keep the configured cascade if ListModels is unavailable or temporarily
  // returns no preferred names; the API call itself is the final authority.
  const configured = supported.length ? supported : preferred;
  return filterCoolingModels(configured, now);
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
  const coolingFiltered = eligibleModels(preferred, available);
  if (!coolingFiltered.length) {
    console.warn("[models] Toate modelele au eșuat recent cu erori explicite; reîncercarea va avea loc după cooldown.");
  }
  return coolingFiltered;
}
