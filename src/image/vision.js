import axios from "axios";
import sharp from "sharp";

// Analiza faciala prin Gemini Vision (multimodal). Folosim Gemini ca motor de:
//  1. detectie fata -> bounding box pentru crop centrat corect;
//  2. verificare "aceeasi persoana?" intre poza de referinta si candidati.
// Cheia se citeste DINAMIC (ESM hoisting - index.js ruleaza dotenv.config()
// dupa importurile modulelor).
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;

// Modele vision, in cascada de fallback. Lite-urile primele: cele mai mari
// cote zilnice si NU intra in conflict cu modelele folosite la rescrierea
// stirilor. Scoatem din lista modelele care dau 404 constant pe acest cont
// (gemini-2.5-flash-lite, gemini-3-flash) - fiecare incercare pe ele inseamna
// doar timp irosit si cascada aluneca pana la Gemma (mult mai slab la comparat
// fețe -> respinsere false, ex. portretul corect primit verdict "NU e persoana").
const VISION_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
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
  let lastError;
  for (const model of VISION_MODELS) {
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

// Verifica daca doua imagini arata ACEEASI persoana (comparare faciala).
// Intoarce true/false; null daca analiza nu a putut fi facuta (apelantul
// decide politica de fallback).
export async function samePerson(referenceBuffer, candidateBuffer) {
  try {
    const refImg = await toInlineJpeg(referenceBuffer);
    const candImg = await toInlineJpeg(candidateBuffer);
    const text = await geminiVision([
      { inlineData: refImg },
      { text: "PRIMA imagine este POZA DE REFERINTA a unei persoane." },
      { inlineData: candImg },
      {
        text: 'A DOUA imagine arata ACEEASI persoana ca in poza de referinta? Comparati trasaturile faciale (forma fetei, ochi, nas, gura, sprancene). Ignorati imbracamintea, fundalul, varsta usor diferita sau unghiul. Raspunde EXACT cu o singura linie: DA sau NU. Daca a doua imagine nu contine clar o fata umana (e obiect, logo, multime indepartata), raspunde NU.',
      },
    ]);
    const verdict = text.split("\n")[0].trim().toUpperCase();
    return verdict.startsWith("DA");
  } catch (err) {
    console.warn(`[vision] samePerson esuat: ${err.message}`);
    return null;
  }
}
