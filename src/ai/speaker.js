import axios from "axios";
import { filterModels } from "./models.js";

// Extrage DINAMIC numele persoanei care declara, CITIND articolul (titlu +
// fragment). Nu depinde de liste predefinite si NU intoarce institutii sau
// subiecte - doar persoane fizice cu nume. Daca articolul nu are o persoana
// centrala care vorbeste (ex: stiri despre legi, institutii, evenimente),
// intoarce null => botul sare direct la imaginea articolului, fara sa arde
// apeluri de verificare faciala pe un "nume" inexistent.
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;

// Lite-urile primele: extragerea vorbitorului e o clasificare simpla pe care
// le fac la fel de bine, iar cotele lor (500/zi) sunt mult mai mari decat ale
// flash-urilor (20/zi) - asa pastram cota modelelor bune pentru rescriere si
// verificarea faciala. Aliasul -latest si Gemma 4 = rezerve.
const SPEAKER_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.7-flash",
  "gemma-4-31b-it",
];

const PROMPT_TEMPLATE = (title, excerpt) => `
Citeste stirea de mai jos si identifica PERSOANA care face declaratiile sau
este figura centrala citata (politician, oficial, ministru, primar etc.).

REGULI:
- Raspunde DOAR cu numele complet al persoanei (ex: "Ilie Bolojan").
- Daca sunt mai multe persoane, alege-o pe cea care DECLARA / este autorul
  afirmatiilor principale (nu persoana despre care se vorbeste).
- Daca stirea NU are nicio persoana clara care declara (subiectul e o lege,
  o institutie, un eveniment, o institutie ca Senatul/Parlamentul/Guvernul
  ca institutie, un raport, un accident), raspunde EXACT: NONE
- NU inventa nume. NU returna functii fara nume ("ministrul", "puricatorul").

TITLU: ${title}

STIRE:
${excerpt}
`;

// Intoarce numele persoanei (string) sau null daca nu exista / a esuat tot.
export async function extractSpeakerFromArticle(title, excerpt) {
  const models = await filterModels(SPEAKER_MODELS);
  for (const model of models) {
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
      const raw = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!raw) throw new Error("raspuns gol");

      const answer = raw.split("\n")[0].trim().replace(/^["']|["']$/g, "");
      if (/^none$/i.test(answer)) {
        console.log(`[speaker] ${model}: nicio persoana care declara in aceasta stire`);
        return null;
      }
      // Validare minimala: un nume are intre 2 si 5 cuvinte, doar litere.
      const words = answer.split(/\s+/);
      const looksLikeName =
        words.length >= 2 &&
        words.length <= 5 &&
        answer.length <= 60 &&
        /^[A-Za-zĂÂÎȘȚăâîșț.\- ]+$/.test(answer);
      if (!looksLikeName) {
        console.log(`[speaker] ${model}: raspuns neconformant pentru un nume: "${answer}"`);
        return null;
      }
      console.log(`[speaker] ${model}: persoana care declara -> ${answer}`);
      return answer;
    } catch (err) {
      console.warn(`[speaker] ${model} a esuat (${err.response?.status || err.message})`);
      continue;
    }
  }
  return null;
}
