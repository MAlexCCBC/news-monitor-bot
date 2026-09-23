import axios from "axios";

const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 60_000;
const SERVICE_FAILURE_WINDOW_MS = 30_000;
const SERVICE_CIRCUIT_MS = 30_000;
const recentUnavailableModels = new Map();
let serviceCircuitOpenUntil = 0;

export function assertGeminiServiceAvailable(now = Date.now()) {
  if (now < serviceCircuitOpenUntil) {
    const waitSeconds = Math.ceil((serviceCircuitOpenUntil - now) / 1000);
    const error = new Error(`Gemini API pare indisponibilă pe mai multe modele; suspend apelurile noi ${waitSeconds}s ca să evit retry-uri în rafală.`);
    error.code = "EGEMINI_CIRCUIT_OPEN";
    error.isGeminiCircuitOpen = true;
    throw error;
  }
}

function noteServiceUnavailable(error, now = Date.now()) {
  const model = error.config?.url?.match(/\/models\/([^/:]+):/)?.[1];
  if (!model) return;
  for (const [name, timestamp] of recentUnavailableModels) {
    if (now - timestamp > SERVICE_FAILURE_WINDOW_MS) recentUnavailableModels.delete(name);
  }
  recentUnavailableModels.set(model, now);
  if (recentUnavailableModels.size >= 2) {
    serviceCircuitOpenUntil = now + SERVICE_CIRCUIT_MS;
    recentUnavailableModels.clear();
    console.warn("[gemini] HTTP 503 pe mai multe modele; deschid circuitul 30s înainte să reiau cascada.");
  }
}

function retryAfterMs(error, now) {
  const headers = error.response?.headers;
  const header = headers?.get?.("retry-after") ?? headers?.["retry-after"];
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - now), MAX_RETRY_DELAY_MS);
  }

  const details = error.response?.data?.error?.details || [];
  const retryInfo = details.find((detail) => String(detail["@type"] || "").endsWith("google.rpc.RetryInfo"));
  const delay = retryInfo?.retryDelay || details.find((detail) => detail.retryDelay)?.retryDelay;
  const parsedDelay = typeof delay === "string" && delay.match(/^(\d+(?:\.\d+)?)s$/);
  if (parsedDelay) return Math.min(Number(parsedDelay[1]) * 1000, MAX_RETRY_DELAY_MS);

  const messageDelay = error.response?.data?.error?.message?.match(/retry in\s+(\d+(?:\.\d+)?)\s*s/i);
  if (messageDelay) return Math.min(Number(messageDelay[1]) * 1000, MAX_RETRY_DELAY_MS);
  return null;
}

function isTransient(error) {
  if (error.isGeminiCircuitOpen) return false;
  const status = error.response?.status;
  return (status >= 500 && status <= 599) || error.code === "ECONNABORTED" ||
    (!error.response && !["ERR_CANCELED", "ERR_BAD_OPTION", "ERR_BAD_OPTION_VALUE"].includes(error.code));
}

export function geminiRetryDelay(error, retryNumber, random = Math.random, now = Date.now()) {
  const serverDelay = retryAfterMs(error, now);
  if (serverDelay !== null) return serverDelay;
  const exponential = Math.min(1000 * (2 ** (retryNumber - 1)), MAX_RETRY_DELAY_MS);
  return Math.round(exponential * (0.75 + random() * 0.5));
}

export async function withGeminiRetries(request, {
  maxRetries = MAX_RETRIES,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  onRetry = (attempt, delayMs, error) => console.warn(
    `[gemini] Eroare tranzitorie HTTP ${error.response?.status || error.code || "rețea"}; reîncercarea ${attempt}/${maxRetries} în ${delayMs}ms`
  ),
} = {}) {
  let retryNumber = 0;
  while (true) {
    try {
      assertGeminiServiceAvailable();
      return await request();
    } catch (error) {
      if (!isTransient(error) || retryNumber >= maxRetries) {
        if (error.response?.status === 503) noteServiceUnavailable(error);
        throw error;
      }
      retryNumber++;
      const delayMs = geminiRetryDelay(error, retryNumber, random);
      onRetry(retryNumber, delayMs, error);
      await sleep(delayMs);
    }
  }
}
