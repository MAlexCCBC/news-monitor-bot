import axios from "axios";
import sharp from "sharp";
import { getRecentImages, saveImage } from "../storage/db.js";

// Citim cheia DINAMIC, in momentul apelului (nu la import): index.js ruleaza
// dotenv.config() dupa ce modulele sunt deja importate (ESM hoisting), deci la
// nivel de modul TAVILY_API_KEY ar fi inca undefined.
const TAVILY_KEY = () => process.env.TAVILY_API_KEY;
const IMAGE_HISTORY_DAYS = () => Number(process.env.IMAGE_HISTORY_DAYS || 7);

// Portret de Wikipedia — cea mai sigura sursa pentru persoana CORECTA.
// Pentru politicieni romani, pagina Wikipedia are intotdeauna o poza oficiala.
// Incercam intai romana, apoi engleza.
// ATENTIE: Wikipedia cere User-Agent valid (altfel 403 Forbidden).
const WIKI_UA = "NewsMonitorBot/1.0 (https://github.com/MAlexCCBC/news-monitor-bot)";

async function searchWikipediaPortrait(personName) {
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
        const results = sr.data && sr.data.query && sr.data.query.search;
        if (!results || results.length === 0) continue;

        const pageTitle = results[0].title;
        const ir = await axios.get(base, {
          params: { action: "query", titles: pageTitle, prop: "pageimages", piprop: "original", pithumbsize: 800, format: "json" },
          headers: { "User-Agent": WIKI_UA },
          timeout: 8000,
        });
        const pages = ir.data && ir.data.query && ir.data.query.pages;
        const page = pages && Object.values(pages)[0];
        if (page && page.original && page.original.source) {
          return { url: page.original.source, lang: lang, title: pageTitle };
        }
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

// Fallback prin DuckDuckGo (scraping HTML, fara API key)
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

// Fallback prin Bing Images (RSS gratuit, fara API key)
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

async function getImageDimensions(imageUrl) {
  try {
    const res = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 15000,
      maxContentLength: 20 * 1024 * 1024,
    });
    const meta = await sharp(res.data).metadata();
    return { width: meta.width, height: meta.height, buffer: res.data };
  } catch {
    return null;
  }
}

// Ajusteaza imaginea la 3:4 (portret) daca nu e deja 3:4 sau 9:16.
// Pentru imaginile late (ex 16:9) crop-ul e orientat pe SUBIECTUL principal
// (fata/persoana) prin strategia "attention" a lui libvips - nu pe mijlocul
// imaginii, ca sa nu tai persoana care sta in stanga sau dreapta.
// Pentru imaginile inalte se pastreaza SUSUL (unde e capul/fata).
async function cropTo3x4(buffer) {
  const meta = await sharp(buffer).metadata();
  const targetRatio = 3 / 4;

  if (meta.width / meta.height > targetRatio) {
    // prea lata (ex 16:9): taiem pe orizontala, dar urmarim persoana
    const cropWidth = Math.round(meta.height * targetRatio);
    return sharp(buffer)
      .resize(cropWidth, meta.height, {
        fit: "cover",
        position: sharp.strategy.attention,
      })
      .toBuffer();
  }

  // prea inalta: taiem pe verticala, tinem crop-ul SUS (capul/fata)
  const cropHeight = Math.round(meta.width / targetRatio);
  return sharp(buffer)
    .resize(meta.width, cropHeight, {
      fit: "cover",
      position: "top",
    })
    .toBuffer();
}

function isAcceptableRatio(width, height) {
  const ratio = width / height;
  const is3x4 = Math.abs(ratio - 3 / 4) < 0.05;
  const is9x16 = Math.abs(ratio - 9 / 16) < 0.05;
  return is3x4 || is9x16;
}

// Descarca o imagine, o decupeaza la 3:4 si intoarce bufferul.
// Returneaza null daca imaginea nu se poate descarca sau e prea mica (sub 100px).
export async function processCandidate(imgUrl) {
  const dims = await getImageDimensions(imgUrl);
  if (!dims) return null;
  if (!dims.width || !dims.height || dims.width < 100 || dims.height < 100) return null;

  let finalBuffer = dims.buffer;
  let note = "Imagine gasita direct in raportul corect (3:4 sau 9:16), lasata asa.";

  if (!isAcceptableRatio(dims.width, dims.height)) {
    finalBuffer = await cropTo3x4(dims.buffer);
    note = "Imaginea nu era 3:4/9:16, a fost decupata automat la 3:4.";
  }

  return { buffer: finalBuffer, sourceUrl: imgUrl, note };
}

// personOrTopic: numele persoanei (daca e declaratie) sau subiectul.
// articleTitle: folosit ca interogare suplimentara cand numele nu da rezultate.
//
// Strategie "mereu imagine":
// 1. PRIMUL pas: cautam portretul de Wikipedia (cea mai sigura sursa pentru
//    persoana corecta — politicienii au poze oficiale pe Wikipedia).
// 2. Daca Wikipedia nu are portret, cautam in Tavily -> DuckDuckGo -> Bing.
// 3. Prima imagine NOUA care se descarca OK e folosita.
// 4. Daca toate esueaza, reutilizeaza o imagine folosita recent (ultima
//    varianta, mai bine o poza repetata decat deloc).
export async function findImage(personOrTopic, articleTitle) {
  const recentImages = getRecentImages(IMAGE_HISTORY_DAYS());
  const usedUrls = new Set(recentImages.map((i) => i.image_url));
  const usedMeta = new Map(recentImages.map((i) => [i.image_url, i]));

  // 1. Portret de Wikipedia — persoana corecta garantat
  const wiki = await searchWikipediaPortrait(personOrTopic);
  if (wiki) {
    const processed = await processCandidate(wiki.url);
    if (processed) {
      saveImage({ imageUrl: wiki.url, personOrTopic });
      console.log("[image] Portret de Wikipedia (" + wiki.lang + "): " + wiki.title);
      return processed;
    }
  }

  // 2. Cautare in motoare (Tavily, DuckDuckGo, Bing)
  const queries = [
    `${personOrTopic} Romania politica`,
    personOrTopic,
    articleTitle ? articleTitle.slice(0, 80) : null,
  ].filter((q) => q && q.trim());

  const engines = [searchTavily, searchDuckDuckGo, searchBingRss];
  const seen = new Set();

  for (const q of queries) {
    for (const engine of engines) {
      const imgs = await engine(q);
      for (const imgUrl of imgs) {
        if (seen.has(imgUrl)) continue;
        seen.add(imgUrl);
        if (usedUrls.has(imgUrl)) continue; // intai cele NOI

        const processed = await processCandidate(imgUrl);
        if (processed) {
          saveImage({ imageUrl: imgUrl, personOrTopic });
          return processed;
        }
      }
    }
  }

  // 3. Ultima varianta: reutilizam o imagine folosita recent, daca apare din nou
  // in rezultate. Alegem imaginea folosita CEL MAI DEMULT (si mai rar), ca sa
  // fie cat mai mult timp intre repetari - nu prima gasita, care s-ar repeta
  // des.
  const reusePool = [];
  for (const imgUrl of seen) {
    const meta = usedMeta.get(imgUrl);
    if (meta) reusePool.push({ url: imgUrl, lastUsed: meta.last_used, usedCount: meta.used_count });
  }
  reusePool.sort((a, b) => a.lastUsed - b.lastUsed || a.usedCount - b.usedCount);

  for (const { url } of reusePool) {
    const processed = await processCandidate(url);
    if (processed) {
      saveImage({ imageUrl: url, personOrTopic });
      return processed;
    }
  }

  return null; // chiar nimic, cautare manuala
}