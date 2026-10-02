import axios from "axios";
import { incidentPrompt, incidentEvidenceDecision } from "../filter/incident-policy.js";
import { hasStrongRomanianContext, hasMajorRomanianEmergencyContext } from "../filter/keywords.js";
import { filterModels, recordModelFailure } from "./models.js";
import { modelGenerationConfig, modelRequestTimeout, withGeminiRetries } from "./gemini-client.js";

// Citim cheia DINAMIC, in momentul apelului (nu la import): index.js ruleaza
// dotenv.config() dupa ce modulele sunt deja importate (ESM hoisting).
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;

// Cascade de modele pt. clasificare: lite-urile primele - clasificarea binara
// DA/NU e simpla si lite-urile o fac la fel de bine, cu cote mult mai mari
// (500/zi fata de 20 pe flash-uri). Aliasul -latest si Gemma 4 = rezerve.
const CLASSIFY_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemma-4-31b-it",
];

const PROMPT_TEMPLATE = (title, excerpt) => `
Esti un filtru de relevanta politica pentru un monitor de stiri politice
romanesti. Primesti TITLUL si un FRAGMENT dintr-un articol publicat intr-un
canal de stiri in limba romana.

INTREBARE: Este articolul in principal despre POLITICA ROMANEASCA, despre un
eveniment politic international cu efect direct si substantial asupra Romaniei,
sau despre un dezastru major din Romania cu raspuns coordonat al autoritatilor?
Cere dovada din subiectul principal, nu doar dintr-o mențiune în treacăt.

Raspunde DA daca:
- Subiectul principal este o decizie, actiune, disputa, declaratie sau evolutie
  de politica romaneasca (Guvern, Parlament, partide, alegeri, politici publice,
  oficiali in exercitarea functiei); SAU
- Este o stire politica internationala cu efect direct si substantial asupra
  Romaniei, demonstrat printr-o decizie/actiune a autoritatilor romane ori un
  efect concret explicit asupra Romaniei. Un posibil efect indirect/geografic
  sau simpla vecinatate cu Romania NU este suficienta.
- Este o urgenta nationala de amploare in Romania (de exemplu incendii de
  vegetatie in mai multe zone/judete) si articolul descrie o mobilizare
  coordonata si exceptionala a structurilor statului, precum sute de salvatori
  sau interventia aeronavelor militare. Asta este exceptie de interes public,
  nu pentru incendii locale obisnuite, accidente ori stiri despre victime.

Raspunde NU daca:
- Articolul este exclusiv despre alte tari sau personaje straine, chiar daca
  este scris in limba romana; SAU
- Romania apare doar incidental, fara rol real (ex: locatie de summit,
  comparatie, simpla preluare a unei stiri internationale); SAU
- Este retrospectiva, calendar istoric, aniversare, istorie sau o retrospectivă
  de arhivă, chiar dacă subiectul istoric a fost politic; SAU
- Este în principal cultură, patrimoniu, restaurare de clădiri, lifestyle,
  eveniment local sau administrație de rutină, fără dispută politică, decizie
  de politică publică ori declarație politică relevantă; SAU
- Este o stire de viata privata, familie, doliu/deces, accident, crima,
  divertisment sau sport, chiar daca mentioneaza un politician roman, fara o
  evolutie politica relevanta ca subiect principal; incendiile/accidentele
  locale obisnuite raman NU daca nu ating pragul de urgenta nationala de mai sus.

TITLU:
${title}

FRAGMENT:
${excerpt}

Raspunde EXACT in acest format (2 linii):
Linia 1: doar DA sau NU
Linia 2: motiv scurt (maxim 15 cuvinte)
`;

// Intoarce:
//   true  -> stirea are relevanta politica romaneasca (trece mai departe)
//   false -> stirea nu are relevanta politica romaneasca (se arunca)
//   null  -> AI-ul nu a putut decide (toate modelele au esuat) => apelantul
//            decide ce fallback foloseste.
export async function isRelevantToRomania(title, excerpt, { incident = false, personalities = [] } = {}) {
  const models = await filterModels(CLASSIFY_MODELS);
  let lastError;
  for (const model of models) {
    try {
      const res = await withGeminiRetries(() => axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          contents: [{ parts: [{ text: incident ? incidentPrompt(title, excerpt) : PROMPT_TEMPLATE(title, excerpt) }] }],
          generationConfig: modelGenerationConfig(model, { temperature: 0, ...(incident && !model.startsWith("gemma-") ? { responseMimeType: "application/json" } : {}) }),
        },
        {
          timeout: modelRequestTimeout(model, 30000),
          headers: {
            "x-goog-api-key": GEMINI_KEY(),
            "Content-Type": "application/json",
          },
        }
      ));
      const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) throw new Error("Raspuns gol de la model");

      if (incident) {
        const decision = incidentEvidenceDecision(text, {
          title, excerpt,
          hasRomanianContext: proof => hasStrongRomanianContext(proof, personalities),
          hasMajorEmergency: hasMajorRomanianEmergencyContext,
        });
        console.log(`[relevanta-incident] ${model}: ${decision.relevant ? "DA" : "NU"} - ${decision.reason}`);
        return decision.relevant;
      }
      const verdict = text.split("\n")[0].trim().toUpperCase();
      if (verdict !== "DA" && verdict !== "NU") {
        throw new Error(`Verdict de relevanță neconform: ${verdict.slice(0, 40)}`);
      }
      const reason = text.split("\n").slice(1).join(" ").trim();
      const relevant = verdict === "DA";

      console.log(
        `[relevanta] ${model}: ${relevant ? "DA (politica romaneasca)" : "NU (fara relevanta politica romaneasca)"} - ${reason || "(fara motiv)"}`
      );
      return relevant;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      recordModelFailure(model, err);
      console.warn(`[relevanta] ${model} a esuat (status ${status}), incerc urmatorul...`);
      continue;
    }
  }
  console.error(`[relevanta] Toate modelele au esuat: ${lastError?.message}`);
  return null;
}
