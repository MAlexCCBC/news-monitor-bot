import axios from "axios";
import { filterModels } from "./models.js";

// Citim cheia DINAMIC (ESM hoisting - index.js ruleaza dotenv.config() dupa
// importurile modulelor).
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;

// Clasificare binara simpla => lite-urile primele (500/zi, cota pastrata pt.
// rescriere/viziune). Aliasul -latest si Gemma 4 = rezerve.
const DUP_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.7-flash",
  "gemma-4-31b-it",
];

const PROMPT_TEMPLATE = (oldText, newText) => `
Primesti doua stiri despre un subiect ASEMANATOR. Embedding-ul de similaritate
le-a considerat apropiate (>80%), dar asta nu inseamna automat ca sunt duplicate.

STIREA VECHA (deja procesata/publicata):
"""
${oldText}
"""

STIREA NOUA (candidat):
"""
${newText}
"""

INTREBARE: Stirea noua este o DUBLURA a celei vechi (aceleasi informatii doar
reformulate/preluate), sau aduce CEVA NOU fata de ea?

Raspunde NOU daca stirea noua contine cel putin UN element absent in cea vecha:
- o declaratie, comentariu sau pozitionare a unei persoane (CHIAR despre acelasi
  eveniment/decizie/raport - ex: decizia Curtii Constitutionale e vechea stire,
  iar comentariul unui politician la ea e stire NOUA);
- un citat direct nou;
- detalii, cifre, documente, reactii sau dezvoltari ulterioare suplimentare.

Raspunde DUBLURA daca stirea noua nu aduce ABSOLUT nimic in plus fata de cea
veche - doar reformuleaza aceleasi fapte (tipic: aceeasi stire preluata de alta
publicatie in aceeasi zi).

IMPORTANT: declaratia noua e criteriul decisiv. Doua stiri despre acelasi
eveniment, una fara declaratii si una CU declaratii = NOU, nu DUBLURA.

Raspunde EXACT in acest format (2 linii):
Linia 1: NOU sau DUBLURA
Linia 2: motiv scurt (maxim 15 cuvinte)
`;

// Intoarce:
//   "NOU"     -> stirea noua aduce declaratii/detalii noi => NU se blocheaza
//   "DUBLURA" -> copie reformulata => se blocheaza ca pana acum
//   null      -> AI indisponibil (apelantul pastreaza comportamentul vechi)
export async function isNewDevelopment(oldTitleAndExcerpt, newTitleAndExcerpt) {
  const models = await filterModels(DUP_MODELS);
  let lastError;
  for (const model of models) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          contents: [{ parts: [{ text: PROMPT_TEMPLATE(oldTitleAndExcerpt, newTitleAndExcerpt) }] }],
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
      if (!text) throw new Error("raspuns gol");

      const firstLine = text.split("\n")[0].trim().toUpperCase();
      const reason = text.split("\n").slice(1).join(" ").trim();
      if (firstLine.startsWith("NOU")) {
        console.log(`[dublura] ${model}: NOU - ${reason}`);
        return "NOU";
      }
      if (firstLine.startsWith("DUBLURA")) {
        console.log(`[dublura] ${model}: DUBLURA - ${reason}`);
        return "DUBLURA";
      }
      throw new Error(`verdict neasteptat: ${firstLine}`);
    } catch (err) {
      lastError = err;
      console.warn(`[dublura] ${model} a esuat (${err.response?.status || err.message})`);
      if (err.response?.status === 429) await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
  }
  console.error(`[dublura] Toate modelele au esuat: ${lastError?.message}`);
  return null;
}
