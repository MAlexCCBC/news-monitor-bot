import axios from "axios";

// Citim cheia DINAMIC, in momentul apelului (nu la import): index.js ruleaza
// dotenv.config() dupa ce modulele sunt deja importate (ESM hoisting).
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;

// Cascade de modele pt. clasificare: incepem cu variantele "lite" (cote zilnice
// mari) ca sa nu consumam cota modelelor bune folosite la rescrierea stirilor.
const CLASSIFY_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
];

const PROMPT_TEMPLATE = (title, excerpt) => `
Esti un filtru de relevanta geografica pentru un monitor de stiri politice
romanesti. Primesti TITLUL si un FRAGMENT dintr-un articol publicat intr-un
canal de stiri in limba romana.

INTREBARE: Subiectul PRINCIPAL al articolului priveste Romania sau
persoane/interese romanesti?

Raspunde DA daca:
- Articolul este despre Romania, politica romaneasca, institutii, oficiali,
  economie, societate sau evenimente petrecute in Romania; SAU
- Este o stire internationala DAR cu legatura DIRECTA si SUBSTANTIALA cu
  Romania (un politician roman comenteaza subiectul, decizia afecteaza direct
  Romania, implica cetateni romani sau diaspora).

Raspunde NU daca:
- Articolul este exclusiv despre alte tari sau personaje straine, chiar daca
  este scris in limba romana; SAU
- Romania apare doar incidental, fara rol real (ex: locatie de summit,
  comparatie, simpla preluare a unei stiri internationale).

TITLU:
${title}

FRAGMENT:
${excerpt}

Raspunde EXACT in acest format (2 linii):
Linia 1: doar DA sau NU
Linia 2: motiv scurt (maxim 15 cuvinte)
`;

// Intoarce:
//   true  -> stirea e relevanta pentru Romania (trece mai departe)
//   false -> stire straina fara legatura romaneasca (se arunca)
//   null  -> AI-ul nu a putut decide (toate modelele au esuat) => apelantul
//            decide ce fallback foloseste.
export async function isRelevantToRomania(title, excerpt) {
  let lastError;
  for (const model of CLASSIFY_MODELS) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          contents: [{ parts: [{ text: PROMPT_TEMPLATE(title, excerpt) }] }],
          generationConfig: { temperature: 0 },
        },
        {
          timeout: 20000,
          headers: {
            "x-goog-api-key": GEMINI_KEY(),
            "Content-Type": "application/json",
          },
        }
      );
      const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) throw new Error("Raspuns gol de la model");

      const verdict = text.split("\n")[0].trim().toUpperCase();
      const reason = text.split("\n").slice(1).join(" ").trim();
      const relevant = verdict.startsWith("DA");

      console.log(
        `[relevanta] ${model}: ${relevant ? "DA (romaneasca)" : "NU (straina)"} - ${reason || "(fara motiv)"}`
      );
      return relevant;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      console.warn(`[relevanta] ${model} a esuat (status ${status}), incerc urmatorul...`);
      continue;
    }
  }
  console.error(`[relevanta] Toate modelele au esuat: ${lastError?.message}`);
  return null;
}
