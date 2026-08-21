import axios from "axios";
import sharp from "sharp";
import { filterModels } from "../ai/models.js";

// Analiza faciala prin Gemini Vision (multimodal). Folosim Gemini ca motor de:
//  1. detectie fata -> bounding box pentru crop centrat corect;
//  2. verificare "aceeasi persoana?" intre poza de referinta si candidati.
// Cheia se citeste DINAMIC (ESM hoisting - index.js ruleaza dotenv.config()
// dupa importurile modulelor).
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;

// Modele vision, de la CEL MAI BUN la cel mai slab. 3.7 flash primul: la
// comparat fețe calitatea modelului e critica (modelele slabe resping portrete
// corecte). Apoi lite-urile - au 500 cereri/zi fata de 20 pe flash-uri, deci
// preiau volumul fara sa moara de 429. gemini-flash-latest = alias mereu
// actual, Gemma 4 = ultima linie (14.4K/zi). Modelele care dau 404 (3-flash,
// 2.5-*) sunt scoase; filterModels le exclude oricum dinamic.
const VISION_MODELS = [
  "gemini-3.7-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
];

// Pregatim imaginea pt. Gemini: JPEG mic (512px max), calitate 80 - requesturi
// rapide si in limitele de dimensiune ale API-ului inline.
export async function toInlineJpeg(buffer, maxSize = 512) {
  const jpeg = await sharp(buffer)
    .resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { mimeType: "image/jpeg", data: jpeg.toString("base64") };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function geminiVision(parts) {
  const models = await filterModels(VISION_MODELS);
  let lastError;
  for (const model of models) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { contents: [{ parts }], generationConfig: { temperature: 0 } },
        {
          timeout: 60000,
          headers: {
            "x-goog-api-key": GEMINI_KEY(),
            "Content-Type": "application/json",
          },
        }
      );
      const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) throw new Error("raspuns gol");
      return text;
    } catch (err) {
      lastError = err;
      console.warn(`[vision] ${model} a esuat (${err.response?.status || err.message})`);
      // La 429 (rate limit) asteptam putin inainte sa trecem la urmatorul
      // model - limitele se pot reseta rapid si salvam un apel din cascada.
      if (err.response?.status === 429) await sleep(2000);
      continue;
    }
  }
  throw new Error(`Toate modelele vision au esuat: ${lastError?.message}`);
}

// Detecteaza fata PRINCIPALA si intoarce bounding box-ul in pixeli:
// { x, y, width, height } sau null daca nu gaseste nicio fata.
// Gemini intoarce coordonate normalizate 0..1000 in format [ymin, xmin, ymax, xmax].
export async function getFaceBox(imageBuffer) {
  try {
    const img = await toInlineJpeg(imageBuffer);
    const text = await geminiVision([
      { inlineData: img },
      {
        text: 'Detecteaza fata PRINCIPALA (persoana centrala/subiectul stirii) din aceasta imagine. Raspunde EXACT cu un JSON in formatul: {"box": [ymin, xmin, ymax, xmax]} unde valorile sunt intregi intre 0 si 1000 (coordonate normalizate). Daca nu exista nicio fata umana, raspunde exact {"box": null}. Nu scrie altceva.',
      },
    ]);
    const jsonText = text.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText);
    if (!parsed.box || !Array.isArray(parsed.box) || parsed.box.length !== 4) return null;

    const [ymin, xmin, ymax, xmax] = parsed.box;
    const meta = await sharp(imageBuffer).metadata();
    const box = {
      x: Math.round((xmin / 1000) * meta.width),
      y: Math.round((ymin / 1000) * meta.height),
      width: Math.round(((xmax - xmin) / 1000) * meta.width),
      height: Math.round(((ymax - ymin) / 1000) * meta.height),
    };
    if (box.width <= 0 || box.height <= 0) return null;
    return box;
  } catch (err) {
    console.warn(`[vision] getFaceBox esuat: ${err.message}`);
    return null;
  }
}

// Verifica candidatul fata de referinta INTR-UN SINGUR apel Gemini, doua
// verdicturi deodata (economie de cota):
//   samePerson - candidatul arata aceeasi persoana ca in referinta?
//   hasText    - candidatul are text vizibil suprapus (watermark, logo post TV,
//                titluri de stire, subtitrari)? Astfel de poze arata neprofesional
//                si sunt respinse.
// Intoarce { samePerson, hasText } cu valori true/false; null pe componenta
// respectiva daca analiza nu a putut fi facuta (apelantul decide fallback-ul).
export async function verifyCandidate(referenceBuffer, candidateBuffer) {
  try {
    const refImg = await toInlineJpeg(referenceBuffer);
    const candImg = await toInlineJpeg(candidateBuffer);
    const text = await geminiVision([
      { inlineData: refImg },
      { text: "PRIMA imagine este POZA DE REFERINTA a unei persoane." },
      { inlineData: candImg },
      {
        text: `Evalueaza A DOUA imagine (candidatul) si raspunde EXACT in acest format, pe 3 linii:
PERSOANA: DA sau NU
TEXT: DA sau NU
MOTIV: maxim 10 cuvinte

PERSOANA - candidatul arata ACEEASI persoana ca in poza de referinta? Comparati trasaturile faciale (forma fetei, ochi, nas, gura). Ignorati imbracamintea, fundalul, varsta usor diferita sau unghiul. Daca a doua imagine nu contine clar o fata umana (obiect, logo, multime indepartata), raspunsul e NU.

TEXT - candidatul contine TEXT vizibil suprapus peste imagine: watermark, nume sau logo de post TV/ziar, titluri de stire, subtitrari, data/ora afisata? Textul mic de tip semnatura a fotografului NU se pune (raspunde NU doar daca textul e vizibil si deranjeaza).`,
      },
    ]);

    const personMatch = text.match(/PERSOANA:\s*(DA|NU)/i);
    const textMatch = text.match(/TEXT:\s*(DA|NU)/i);
    if (!personMatch) {
      console.warn(`[vision] verifyCandidate: format neasteptat: ${text.slice(0, 80)}`);
      return { samePerson: null, hasText: null };
    }
    return {
      samePerson: personMatch[1].toUpperCase() === "DA",
      hasText: textMatch ? textMatch[1].toUpperCase() === "DA" : null,
    };
  } catch (err) {
    console.warn(`[vision] verifyCandidate esuat: ${err.message}`);
    return { samePerson: null, hasText: null };
  }
}
