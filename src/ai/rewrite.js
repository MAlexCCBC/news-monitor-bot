import axios from "axios";
import { filterModels } from "./models.js";

// Citim cheia DINAMIC, in momentul apelului (nu la import): index.js ruleaza
// dotenv.config() dupa ce modulele sunt deja importate (ESM hoisting), deci la
// nivel de modul GEMINI_API_KEY ar fi inca undefined.
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;

// Cascada de fallback, de la CEL MAI BUN model la cel mai slab. 3.7 flash e
// varful; lite-urile au cele mai mari cote zilnice (500/zi) deci preiau volumul
// dupa ce flash-urile (20/zi) se epuizeaza. gemini-flash-latest e alias care
// indica mereu cel mai nou flash - plasă de siguranță dacă o versiune dispare.
// Modelele care dau 404 pe acest cont (gemini-3-flash, 2.5-flash, 2.5-lite)
// sunt scoase; filterModels le exclude oricum dinamic, la pornire.
const TEXT_MODELS = [
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-latest",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
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

export async function rewriteArticle(articleText) {
  const models = await filterModels(TEXT_MODELS);
  let lastError;
  for (const model of models) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          contents: [{ parts: [{ text: PROMPT_TEMPLATE(articleText) }] }],
        },
        {
          timeout: 30000,
          headers: {
            "x-goog-api-key": GEMINI_KEY(),
            "Content-Type": "application/json",
          },
        }
      );
      const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Raspuns gol de la model");
      console.log(`[ai] Reformatare reusita cu modelul: ${model}`);
      return { text, modelUsed: model };
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      console.warn(`[ai] ${model} a esuat (status ${status}), incerc urmatorul model...`);
      continue;
    }
  }
  throw new Error(`Toate modelele text au esuat: ${lastError?.message}`);
}
