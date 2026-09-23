import axios from "axios";

const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 60_000;
export const GEMMA4_TIMEOUT_MS = 120_000;

export function modelRequestTimeout(model, fallbackTimeoutMs = null) {
  return model.startsWith("gemma-4-") ? GEMMA4_TIMEOUT_MS : fallbackTimeoutMs;
}

export function modelGenerationConfig(model, baseConfig = {}) {
  const thinkingConfig = { includeThoughts: false };
  if (model.startsWith("gemma-4-")) thinkingConfig.thinkingLevel = "minimal";
  return { ...baseConfig, thinkingConfig };
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
  if (error.isGeminiCircuitOpen || isRequestTimeout(error)) return false;
  const status = error.response?.status;
  return (status >= 500 && status <= 599) || error.code === "ECONNABORTED" ||
    (!error.response && !["ERR_CANCELED", "ERR_BAD_OPTION", "ERR_BAD_OPTION_VALUE"].includes(error.code));
}

export function isRequestTimeout(error) {
  return error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT" || /timeout/i.test(error?.message || "");
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
      return await request();
    } catch (error) {
      // A 503 is commonly a shared backend-capacity incident, not a model
      // specific transient. Retrying it multiple times before falling back
      // fans out requests across the same overloaded service. Let the caller
      // try the next configured model. Every model is attempted at most once
      // per cascade, and actual failures cool down only that specific model.
      if (error.response?.status === 503) {
        throw error;
      }
      if (!isTransient(error) || retryNumber >= maxRetries) {
        throw error;
      }
      retryNumber++;
      const delayMs = geminiRetryDelay(error, retryNumber, random);
      onRetry(retryNumber, delayMs, error);
      await sleep(delayMs);
    }
  }
}
