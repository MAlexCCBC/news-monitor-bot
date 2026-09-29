import axios from "axios";
import { describeGeminiError, filterModels, recordModelFailure } from "./models.js";
import { isRequestTimeout, modelGenerationConfig, modelRequestTimeout, withGeminiRetries } from "./gemini-client.js";

// Citim cheia DINAMIC, in momentul apelului (nu la import): index.js ruleaza
// dotenv.config() dupa ce modulele sunt deja importate (ESM hoisting), deci la
// nivel de modul GEMINI_API_KEY ar fi inca undefined.
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;
const OPENAI_KEY = () => process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-6-luna";
let missingOpenAiKeyLogged = false;

// Cascada începe cu modelul preferat, apoi încearcă Flash/Lite/Gemma ca rezerve.
// gemini-flash-latest e alias care
// indica mereu cel mai nou flash - plasă de siguranță dacă o versiune dispare.
// ListModels elimină automat modelele care nu suportă generateContent pe cheia
// curentă; variantele preview/legacy rămân rezerve dacă sunt disponibile.
export const TEXT_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
  "gemini-flash-lite-latest",
  "gemini-flash-latest",
];

const PROMPT_TEMPLATE = (articleText) => `
Esti un editor de stiri politice din Romania. Primesti textul brut al unui articol
si trebuie sa il transformi intr-o postare gata de publicat, in formatul de mai jos.

Reguli STRICTE:
1. NU folosi markdown deloc: fara **, fara *, fara _, fara #.
2. Titlul (prima linie) e scris DOAR cu MAJUSCULE, precedat de un emoji relevant,
   si rezuma esenta stirii intr-o singura fraza.
3. Urmeaza un paragraf de context (2-3 fraze) care explica cine, ce, cand,
   scris amplu si clar, cu toti termenii cheie.
4. Apoi o linie scurta de introducere care rezuma sectiunea de mai jos,
   terminata cu ":". Ex: "📌 Sintetizarea pozitiilor oficiale:".
5. Apoi 3-4 puncte cheie, fiecare pe o linie separata, in formatul EXACT
   "• EMOJI Text" (punct, spatiu, emoji, spatiu, text). Fiecare punct e scris
   amplu, in 1-2 fraze complete, nu doar o eticheta scurta. Ex:
   "• 🤝 Mobilizare interna: Conducerea partidului transmite un mesaj ferm de
   unitate, subliniind ca presedintele este stabilit exclusiv prin votul membrilor."
6. La final, un citat REAL, copiat cat mai exact (cuvant cu cuvant) dintr-o
   declaratie care apare intre ghilimele in articol, urmat de numele si functia
   persoanei. Citatul incepe cu litera mare. DACA articolul NU contine niciun
   citat intre ghilimele, NU inventa unul: in schimb, scrie o fraza de rezumat
   de tip "Oficialul a declarat ca ...", fara ghilimele.
7. Ultima parte: o intrebare deschisa catre cititori, precedata de 💬, pe o
   singura linie. Dupa intrebare, lasa o linie goala, apoi ultima linie a
   postarii este exact: 👇 Așteptăm opinia ta în comentarii!
8. NU inventa informatii care nu apar in text. NU adauga detalii, cifre, nume
   sau citate care nu reies din articol.
9. CRITICAL: Pastreaza EXACT titlurile si functiile asa cum apar in articol.
   Daca articolul zice "ministrul Muncii" — scrie "ministrul Muncii", NU
   "prim-ministrul" sau alta functie inventata. Daca articolul zice "primarul
   Sectorului 6" — scrie "primarul Sectorului 6", NU "primarul Bucurestiului".
   NU folosi cunostinte externe despre cine ce functie are in prezent — foloseste
   DOAR informatiile din articolul primit.
10. Scrie in romana, ton neutru-jurnalistic dar cu impact, cu fraze curgatoare.

Text articol brut:
"""
${articleText}
"""

Raspunde DOAR cu postarea finala, fara alte comentarii sau explicatii.
`;

export function isCompleteRewrite(text, finishReason) {
  const cleaned = String(text || "").trim();
  const bulletCount = (cleaned.match(/^•\s/gm) || []).length;
  const hasRequiredEnding = cleaned.endsWith("👇 Așteptăm opinia ta în comentarii!");
  return finishReason === "STOP" && bulletCount >= 3 && hasRequiredEnding;
}

function normalizeGroundingText(text = "") {
  return String(text).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function sourceContainsPhrase(source, value) {
  const phrase = normalizeGroundingText(value);
  return phrase.length > 0 && (` ${source} `).includes(` ${phrase} `);
}

// A complete-looking post can still contain a quote or a second story that
// was never in the scraped article. Keep these checks local: no extra API call,
// and fail over to another writer model instead of publishing unsupported text.
export function validateRewriteGrounding(text, articleText) {
  const source = normalizeGroundingText(articleText);
  const failures = [];
  const quotes = [...String(text || "").matchAll(/[„“"]([^”"\n]{12,})[”"]/g)].map((match) => match[1]);
  for (const quote of quotes) {
    if (!sourceContainsPhrase(source, quote)) {
      failures.push("citatul nu apare în articolul-sursă");
      break;
    }
  }

  // Proper-name pairs are strong signals of cross-article contamination (for
  // example, a political quote inserted into an unrelated court story). Ignore
  // common sentence starters; check the remaining names as contiguous phrases.
  const sentenceStarters = new Set([
    "in", "dupa", "potrivit", "conform", "de", "acest", "aceasta", "contextul", "detalii",
    "principalele", "situatia", "procesul", "calendarul", "programul", "rezultatele",
    "reactia", "pozitia", "decizia", "masurile", "oficialii", "autoritatile",
    "presedintele", "liderul", "ministrul", "premierul", "sursa", "romania",
    // The name detector also matches institutions, places, and venues as if
    // they were people. Sources frequently use acronyms or different inflected
    // forms (BNR / Banca Națională; Cehia / Republica Cehă), so don't reject a
    // rewrite on those generic entity labels alone.
    "banca", "bancii", "guvernatorul", "guvernatoarea", "camera", "camerei",
    "republica", "republicii", "vila", "comisia", "comisiei", "ministerul",
    "ministerului", "guvernul", "guvernului", "parlamentul", "parlamentului",
    "uniunea", "uniunii", "consiliul", "consiliului", "ambasada", "ambasadorul",
    "ambasadoarea", "curtea", "curtii", "biserica", "bisericii", "orasul",
    "orasului", "provincia", "provinciei", "statul", "statelor", "institutul",
    "institutului", "comitetul", "comitetului", "partidul", "partidului",
  ]);
  const names = String(text || "").match(/\b[A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+){1,2}\b/g) || [];
  const unsupportedName = names.find((name) => {
    const normalized = normalizeGroundingText(name);
    return !sentenceStarters.has(normalized.split(" ")[0]) && !sourceContainsPhrase(source, name);
  });
  if (unsupportedName) failures.push(`numele „${unsupportedName}” nu apare în articolul-sursă`);

  const outputNumbers = String(text || "").match(/\b\d+(?:[.,]\d+)?\b/g) || [];
  const unsupportedNumber = outputNumbers.find((value) => !sourceContainsPhrase(source, value));
  if (unsupportedNumber) failures.push(`numărul „${unsupportedNumber}” nu apare în articolul-sursă`);
  return failures;
}

export function extractFinalRewriteText(candidate) {
  return (candidate?.content?.parts || [])
    .filter((part) => part && part.thought !== true && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

export function extractOpenAIRewriteText(response) {
  if (typeof response?.output_text === "string") return response.output_text.trim();
  return (response?.output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content || [])
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

async function rewriteWithOpenAI(articleText) {
  const apiKey = OPENAI_KEY();
  if (!apiKey) return null;
  const response = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: OPENAI_MODEL,
      reasoning: { effort: "medium" },
      max_output_tokens: 6000,
      input: PROMPT_TEMPLATE(articleText),
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );
  const text = extractOpenAIRewriteText(response.data);
  if (!text) throw new Error(`Răspuns gol de la OpenAI (status=${response.data?.status || "necunoscut"})`);
  if (response.data?.status && response.data.status !== "completed") {
    throw new Error(`Răspuns OpenAI incomplet (status=${response.data.status})`);
  }
  if (!isCompleteRewrite(text, "STOP")) throw new Error("Postare OpenAI incompletă");
  const groundingFailures = validateRewriteGrounding(text, articleText);
  if (groundingFailures.length) {
    throw new Error(`Postare cu informații neancorate: ${groundingFailures.join("; ")}`);
  }
  const usage = response.data?.usage;
  if (usage) {
    const inputTokens = Number(usage.input_tokens || 0);
    const outputTokens = Number(usage.output_tokens || 0);
    const reasoningTokens = Number(usage.output_tokens_details?.reasoning_tokens || 0);
    const cachedInputTokens = Number(usage.input_tokens_details?.cached_tokens || 0);
    const longContext = inputTokens > 272_000;
    const inputRate = longContext ? 0.20 : 0.10;
    const cachedInputRate = longContext ? 0.02 : 0.01;
    const outputRate = longContext ? 0.75 : 0.50;
    const estimatedUsd = Math.max(0, inputTokens - cachedInputTokens) * inputRate / 1_000_000 +
      cachedInputTokens * cachedInputRate / 1_000_000 + outputTokens * outputRate / 1_000_000;
    console.log(`[openai] ${OPENAI_MODEL} reușit: input=${inputTokens}, output=${outputTokens}, reasoning=${reasoningTokens}, cost_est=$${estimatedUsd.toFixed(6)}`);
  } else {
    console.log(`[openai] Reformatare reușită cu ${OPENAI_MODEL}; API-ul nu a returnat usage.`);
  }
  return { text, modelUsed: OPENAI_MODEL };
}

export async function rewriteArticle(articleText) {
  if (OPENAI_KEY()) {
    try {
      const result = await rewriteWithOpenAI(articleText);
      if (result) return result;
    } catch (err) {
      console.warn(`[openai] ${OPENAI_MODEL} a eșuat (${err.response?.status || err.message}); continui cu fallbackurile Gemini.`);
    }
  } else {
    if (!missingOpenAiKeyLogged) {
      console.warn("[openai] OPENAI_API_KEY lipsește; continui direct cu fallbackurile Gemini.");
      missingOpenAiKeyLogged = true;
    }
  }
  const models = await filterModels(TEXT_MODELS);
  if (!models.length) {
    throw new Error("Toate modelele text sunt temporar în cooldown după erori de cotă; articolul nu a fost trimis către Gemini. Reîncearcă după resetarea cotei.");
  }
  let lastError;
  const failures = [];
  for (const model of models) {
    try {
      const res = await withGeminiRetries(() => axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          contents: [{ parts: [{ text: PROMPT_TEMPLATE(articleText) }] }],
          generationConfig: modelGenerationConfig(model),
        },
        {
          // Gemma 4 gets a longer window; Gemini retains the user's no-timeout
          // preference for rewrite requests.
          timeout: modelRequestTimeout(model),
          headers: {
            "x-goog-api-key": GEMINI_KEY(),
            "Content-Type": "application/json",
          },
        }
      ));
      const candidate = res.data.candidates?.[0];
      const text = extractFinalRewriteText(candidate);
      const finishReason = candidate?.finishReason;
      if (!text) throw new Error(`Răspuns gol de la model (finishReason=${finishReason || "necunoscut"})`);
      if (!isCompleteRewrite(text, finishReason)) {
        const bulletCount = (text.match(/^•\s/gm) || []).length;
        const hasRequiredEnding = text.endsWith("👇 Așteptăm opinia ta în comentarii!");
        console.warn(`[ai] ${model} a returnat o postare incompletă (finishReason=${finishReason || "necunoscut"}, bullets=${bulletCount}, final=${hasRequiredEnding}); încerc următorul model.`);
        lastError = new Error(`Postare incompletă (finishReason=${finishReason || "necunoscut"})`);
        failures.push(`${model}: răspuns incomplet (${finishReason || "finishReason lipsă"})`);
        continue;
      }
      const groundingFailures = validateRewriteGrounding(text, articleText);
      if (groundingFailures.length) {
        lastError = new Error(`Postare cu informații neancorate: ${groundingFailures.join("; ")}`);
        failures.push(`${model}: ${lastError.message}`);
        console.warn(`[ai] ${model} a adăugat informații neconfirmate (${groundingFailures.join("; ")}); încerc următorul model.`);
        continue;
      }
      console.log(`[ai] Reformatare reusita cu modelul: ${model}`);
      return { text, modelUsed: model };
    } catch (err) {
      lastError = err;
      recordModelFailure(model, err);
      const reason = describeGeminiError(err);
      failures.push(`${model}: ${reason}`);
      if (isRequestTimeout(err)) {
        console.warn(`[ai] ${model} a eșuat la timeout-ul HTTP, încerc următorul model...`);
      } else {
        console.warn(`[ai] ${model} a eșuat (${reason}), încerc următorul model disponibil...`);
      }
      continue;
    }
  }
  throw new Error(`Toate modelele text au eșuat după ${models.length} încercări: ${failures.join(" | ") || describeGeminiError(lastError)}`);
}
