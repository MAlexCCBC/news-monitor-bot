import axios from "axios";
import sharp from "sharp";
import { getRecentImages, saveImage } from "../storage/db.js";
import { getFaceBox, samePerson } from "./vision.js";

const TAVILY_KEY = () => process.env.TAVILY_API_KEY;
const IMAGE_HISTORY_DAYS = () => Number(process.env.IMAGE_HISTORY_DAYS || 7);

// Referinta faciala vine de pe Wikipedia: poza oficiala a persoanei corecte.
// ATENTIE: e folosita DOAR ca referinta pentru compararea faciala, NU ca
// imagine postata (vrem poze NOUA de pe net, verificate contra acesteia).
// Wikipedia cere User-Agent valid (altfel 403 Forbidden).
const WIKI_UA = "NewsMonitorBot/1.0 (https://github.com/MAlexCCBC/news-monitor-bot)";

async function fetchWikipediaReference(personName) {
  const names = [personName];
  const parts = personName.split(/\s+/);
  if (parts.length >= 2) names.push(parts[parts.length - 1]); // doar "Bolojan"

  for (const name of names) {
    for (const lang of ["ro", "en"]) {
      try {
        const base = "https://" + lang + ".wikipedia.org/w/api.php";
        const sr = await axios.get(base, {
          params: { action: "query", list: "search", srsearch: name, srlimit: 1, format: "json" },
          headers: { "User-Agent": WIKI_UA },
          timeout: 8000,
        });
        const results = sr.data?.query?.search;
        if (!results || results.length === 0) continue;

        const pageTitle = results[0].title;
        const ir = await axios.get(base, {
          params: { action: "query", titles: pageTitle, prop: "pageimages", piprop: "original", pithumbsize: 800, format: "json" },
          headers: { "User-Agent": WIKI_UA },
          timeout: 8000,
        });
        const page = Object.values(ir.data?.query?.pages || {})[0];
        const src = page?.original?.source;
        if (!src) continue;

        const dl = await axios.get(src, {
          responseType: "arraybuffer",
          headers: { "User-Agent": WIKI_UA },
          timeout: 15000,
          maxContentLength: 20 * 1024 * 1024,
        });
        console.log(`[image] Referinta faciala Wikipedia (${lang}): ${pageTitle}`);
        return { buffer: dl.data, title: pageTitle, lang, url: src };
      } catch {}
    }
  }
  return null;
}

async function searchTavily(query) {
  const res = await axios.post(
    "https://api.tavily.com/search",
    {
      api_key: TAVILY_KEY(),
      query: `${query} Romania foto stiri`,
      include_images: true,
      max_results: 15,
    },
    { timeout: 15000 }
  );
  return res.data.images || [];
}

async function searchDuckDuckGo(query) {
  try {
    const res = await axios.get("https://duckduckgo.com/i.js", {
      params: { q: query, t: "images" },
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      timeout: 15000,
    });
    return (res.data.results || []).map((r) => r.image);
  } catch {
    return [];
  }
}

function decodeUrl(u) {
  try {
    return decodeURIComponent(u);
  } catch {
    return u;
  }
}

async function searchBingRss(query) {
  try {
    const res = await axios.get("https://www.bing.com/images/search", {
      params: { q: query, format: "rss" },
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      timeout: 15000,
    });
    const urls = [...res.data.matchAll(/<m:url>(.*?)<\/m:url>/gs)].map((m) => decodeUrl(m[1]));
    return urls.filter((u) => /^https?:\/\//.test(u));
  } catch {
    return [];
  }
}

async function downloadImage(imageUrl) {
  try {
    const res = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 15000,
      maxContentLength: 20 * 1024 * 1024,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    const meta = await sharp(res.data).metadata();
    if (!meta.width || !meta.height || meta.width < 100 || meta.height < 100) return null;
    return { width: meta.width, height: meta.height, buffer: res.data };
  } catch {
    return null;
  }
}

// Crop 3:4 CENTRAT PE FATA cand avem bounding box-ul (din Gemini): fata sta in
// treimea de sus a cadrului, cu spatiu pentru corp sub ea - compozitie de
// portret. Fara box, cadem pe strategia "attention" a lui libvips.
export async function cropPortrait3x4(buffer, faceBox = null) {
  const meta = await sharp(buffer).metadata();
  const targetRatio = 3 / 4;
  const isWide = meta.width / meta.height > targetRatio;

  let left, top, cropW, cropH;

  if (isWide) {
    // Prea lata: decupam latimea. Inaltimea ramane intreaga.
    cropH = meta.height;
    cropW = Math.round(cropH * targetRatio);
    if (faceBox) {
      // Centram fata orizontal, dar tinem cadrul in limitele imaginii.
      const faceCx = faceBox.x + faceBox.width / 2;
      left = Math.round(faceCx - cropW / 2);
    } else {
      left = null; // lasam libvips sa decida (attention)
    }
    top = 0;
    if (left !== null) {
      left = Math.max(0, Math.min(left, meta.width - cropW));
      return sharp(buffer)
        .extract({ left, top, width: cropW, height: cropH })
        .toBuffer();
    }
    return sharp(buffer)
      .resize(cropW, cropH, { fit: "cover", position: sharp.strategy.attention })
      .toBuffer();
  }

  // Prea inalta: decupam inaltimea. Latimea ramane intreaga.
  cropW = meta.width;
  cropH = Math.round(cropW / targetRatio);
  if (faceBox) {
    // Fata la ~1/4 din inaltimea cadrului, ca sa iasa portret cu corp.
    top = Math.round(faceBox.y + faceBox.height / 2 - cropH * 0.25);
  } else {
    top = Math.round(meta.height * 0.1); // aproape de sus, unde e capul
  }
  top = Math.max(0, Math.min(top, meta.height - cropH));
  return sharp(buffer)
    .extract({ left: 0, top, width: cropW, height: cropH })
    .toBuffer();
}

// Descarca, verifica si decupeaza un candidat.
// referenceBuffer: poza oficiala a vorbitorului (Wikipedia). Daca exista,
// candidatul e acceptat DOAR daca Gemini confirma aceeasi persoana.
// Intoarce null daca imaginea respinsa (persoana diferita / nefaciala / moarta).
async function buildCandidate(imgUrl, personName, referenceBuffer) {
  const dims = await downloadImage(imgUrl);
  if (!dims) return null;

  if (referenceBuffer) {
    const verdict = await samePerson(referenceBuffer, dims.buffer);
    if (verdict === false) {
      console.log(`[image] Respins (NU e ${personName}): ${imgUrl}`);
      return null;
    }
    if (verdict === null) {
      // Analiza nedisponibila: acceptam, dar logam - mai bine o poza plauzibila
      // decat deloc (numele era deja cel al vorbitorului in cautare).
      console.log(`[image] Verificare faciala indisponibila, accept oricum: ${imgUrl}`);
    } else {
      console.log(`[image] Confirmat facial (${personName}): ${imgUrl}`);
    }
  }

  const faceBox = await getFaceBox(dims.buffer);
  const finalBuffer = await cropPortrait3x4(dims.buffer, faceBox);
  return {
    buffer: finalBuffer,
    sourceUrl: imgUrl,
    note: faceBox
      ? "Imagine verificata facial si decupata centrat pe fata."
      : "Imagine decupata la 3:4 cu focalizare pe subiect.",
  };
}

// Imaginea ARTICOLULUI insusi (og:image): e deja relevanta contextual, o
// decupam doar centrat pe fata, fara verificare faciala.
export async function processArticleImage(imgUrl) {
  const dims = await downloadImage(imgUrl);
  if (!dims) return null;
  const faceBox = await getFaceBox(dims.buffer);
  return {
    buffer: await cropPortrait3x4(dims.buffer, faceBox),
    sourceUrl: imgUrl,
    note: faceBox
      ? "Imaginea articolului, decupata centrat pe fata."
      : "Imaginea articolului, decupata la 3:4.",
  };
}

// Flux complet pentru o persoana/subiect:
//  1. Ia portretul Wikipedia ca REFERINTA faciala (nu il posteaza).
//  2. Cauta poze pe net (Tavily -> DuckDuckGo -> Bing) cu numele vorbitorului.
//  3. Fiecare candidat e verificat facial contra referintei, apoi cropuit
//     centrat pe fata. Primul confirmat castiga; preferam pozele NEfolosite.
//  4. Daca nimic nu trece verificarea, POSTAM referinta Wikipedia - persoana
//     corecta garantat, mai bine decat o poza gresita sau deloc.
export async function findImage(personOrTopic, articleTitle) {
  const recentImages = getRecentImages(IMAGE_HISTORY_DAYS());
  const usedUrls = new Set(recentImages.map((i) => i.image_url));
  const usedMeta = new Map(recentImages.map((i) => [i.image_url, i]));

  // 1. Referinta faciala
  const reference = await fetchWikipediaReference(personOrTopic);
  const referenceBuffer = reference?.buffer || null;

  // 2. Candidati din motoare
  const queries = [
    `${personOrTopic} Romania stiri`,
    personOrTopic,
    articleTitle ? articleTitle.slice(0, 80) : null,
  ].filter((q) => q && q.trim());

  const engines = [searchTavily, searchDuckDuckGo, searchBingRss];
  const seen = new Set();
  let winner = null;

  // Plafon de verificari faciale per cautare: fiecare candidat consuma 1-2
  // apeluri Gemini (samePerson + getFaceBox). Fara plafon, o lista lunga de
  // candidati respinsi arde toata cota zilnica (s-a vazut: 15+ verificari ->
  // 429 rate limit). Dupa 6 verificari neconcludente, oprim cautarea.
  const MAX_FACE_CHECKS = 6;
  let faceChecks = 0;

  searchLoop: for (const q of queries) {
    for (const engine of engines) {
      const imgs = await engine(q);
      for (const imgUrl of imgs) {
        if (seen.has(imgUrl)) continue;
        seen.add(imgUrl);
        if (usedUrls.has(imgUrl)) continue;
        if (faceChecks >= MAX_FACE_CHECKS) break searchLoop;

        faceChecks++;
        const candidate = await buildCandidate(imgUrl, personOrTopic, referenceBuffer);
        if (candidate) {
          saveImage({ imageUrl: imgUrl, personOrTopic });
          winner = candidate;
          break searchLoop;
        }
      }
    }
  }

  if (!winner) {
    // 4. Nimic verificat: postam direct referinta Wikipedia (persoana sigura),
    // daca o avem. Altfel incercam reutilizarea unei imagini vechi.
    if (referenceBuffer) {
      const faceBox = await getFaceBox(referenceBuffer);
      const processed = {
        buffer: await cropPortrait3x4(referenceBuffer, faceBox),
        sourceUrl: reference.url || null,
        note: "Portret oficial (Wikipedia) - nu am gasit poze noi verificate facial.",
      };
      saveImage({ imageUrl: reference.url || "", personOrTopic });
      console.log("[image] Fallback: folosesc portretul Wikipedia al vorbitorului");
      return processed;
    }

    // Reutilizare LRU din istoricul recent (ultima varianta inainte de nimic).
    const reusePool = [];
    for (const imgUrl of seen) {
      const meta = usedMeta.get(imgUrl);
      if (meta) reusePool.push({ url: imgUrl, lastUsed: meta.last_used, usedCount: meta.used_count });
    }
    reusePool.sort((a, b) => a.lastUsed - b.lastUsed || a.usedCount - b.usedCount);
    for (const { url } of reusePool) {
      const candidate = await buildCandidate(url, personOrTopic, referenceBuffer);
      if (candidate) {
        saveImage({ imageUrl: url, personOrTopic });
        return candidate;
      }
    }
  }

  return winner;
}
