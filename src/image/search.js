import axios from "axios";
import sharp from "sharp";
import { getRecentImages, saveImage } from "../storage/db.js";
import { getFaceBox, verifyCandidate, verifyPersonByName } from "./vision.js";
import { imageIdentity, recentImageKeys, diverseImageCandidates, commonsPhotoCandidates, imageFingerprint, isRecentVisualDuplicate } from "./selection.js";
import { isArticleImageCandidate, isVerifiedPersonImageAllowed } from "./policy.js";

const TAVILY_KEY = () => process.env.TAVILY_API_KEY;
const IMAGE_HISTORY_DAYS = () => Number(process.env.IMAGE_HISTORY_DAYS || 7);
let tavilyUnavailableUntil = 0;

// Referinta faciala vine de pe Wikipedia: poza oficiala a persoanei corecte.
// ATENTIE: e folosita DOAR ca referinta pentru compararea faciala, NU ca
// imagine postata (vrem poze NOUA de pe net, verificate contra acesteia).
// Wikipedia cere User-Agent valid (altfel 403 Forbidden).
const WIKI_UA = "NewsMonitorBot/1.0 (https://github.com/MAlexCCBC/news-monitor-bot)";

// Verifica ca titlul paginii Wikipedia corespunde persoanei cautate.
// Nume compuse ("Dominic Fritz"): TOATE cuvintele trebuie sa apara in titlu
// ca cuvinte intregi. Nume simple ("Fritz", fallback pe nume de familie):
// doar egalitate EXACTA - altfel cautarea "Fritz" returna portretul lui
// Fritz Bauer (vânătorul de naziști), nu al politicianului nostru.
function pageTitleMatches(pageTitle, personName) {
  const norm = (s) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const titleNorm = norm(pageTitle);
  const nameWords = norm(personName).replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter(Boolean);
  if (nameWords.length === 0) return false;
  if (nameWords.length === 1) return titleNorm === nameWords[0];
  const titleWords = new Set(titleNorm.replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/));
  return nameWords.every((w) => titleWords.has(w));
}

async function fetchWikipediaReference(personName) {
  const names = [personName];
  const parts = personName.split(/\s+/);
  if (parts.length >= 2) names.push(parts[parts.length - 1]); // doar "Bolojan"

  for (const name of names) {
    for (const lang of ["ro", "en"]) {
      try {
        const base = "https://" + lang + ".wikipedia.org/w/api.php";
        const sr = await axios.get(base, {
          params: { action: "query", list: "search", srsearch: `"${name}"`, srlimit: 10, format: "json" },
          headers: { "User-Agent": WIKI_UA },
          timeout: 8000,
        });
        const results = sr.data?.query?.search;
        if (!results || results.length === 0) continue;

        // Luam PRIMA pagina al carei titlu se potriveste cu numele persoanei
        // (toate cuvintele numelui prezente in titlu), nu orice prim rezultat.
        let pageTitle = null;
        for (const r of results) {
          if (pageTitleMatches(r.title, name)) {
            pageTitle = r.title;
            break;
          }
        }
        if (!pageTitle) continue; // nicio potrivire credibila => nu ghicim

        const ir = await axios.get(base, {
          params: { action: "query", titles: pageTitle, redirects: 1, prop: "pageimages", piprop: "original|thumbnail", pithumbsize: 1000, format: "json" },
          headers: { "User-Agent": WIKI_UA },
          timeout: 8000,
        });
        const page = Object.values(ir.data?.query?.pages || {})[0];
        const src = page?.original?.source || page?.thumbnail?.source;
        if (!src) continue;

        const dl = await axios.get(src, {
          responseType: "arraybuffer",
          headers: { "User-Agent": WIKI_UA },
          timeout: 15000,
          maxContentLength: 20 * 1024 * 1024,
        });
        console.log(`[image] Referinta faciala Wikipedia (${lang}): ${pageTitle}`);
        return { buffer: dl.data, title: pageTitle, lang, url: src };
      } catch (err) {
        console.warn(`[image] Wikipedia ${lang} lookup pentru "${name}" a eșuat (${err.response?.status || err.message})`);
      }
    }
  }
  console.warn(`[image] Nicio imagine de referință Wikipedia exactă găsită pentru "${personName}"`);
  return null;
}

async function searchTavily(query) {
  const key = TAVILY_KEY();
  if (!key || Date.now() < tavilyUnavailableUntil) return [];
  try {
    const res = await axios.post(
      "https://api.tavily.com/search",
      {
        api_key: key,
        query: `${query} Romania foto stiri`,
        include_images: true,
        max_results: 15,
      },
      { timeout: 15000 }
    );
    return (res.data?.images || []).filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
  } catch (err) {
    const status = err.response?.status;
    if ([401, 403, 432, 433].includes(status)) {
      // 432/433 are plan-limit errors, not per-query search failures. Stop
      // wasting one failed API call for every query/article in this run.
      tavilyUnavailableUntil = Date.now() + 12 * 60 * 60 * 1000;
      console.warn(`[image] Tavily indisponibil (${status}); îl sar următoarele 12h și folosesc celelalte surse.`);
    } else {
      console.warn(`[image] Tavily search indisponibil (${status || err.message}), trecem la urmatorul motor...`);
    }
    return [];
  }
}

async function searchBingHtml(query) {
  try {
    const res = await axios.get("https://www.bing.com/images/search", {
      params: { q: `${query} Romania`, qft: "+filterui:photo-photo" },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      },
      timeout: 15000,
    });
    const urls = [];
    const matches = res.data.matchAll(/murl&quot;:&quot;(https?:\/\/[^&"]+)&quot;/g);
    for (const m of matches) {
      if (!urls.includes(m[1])) urls.push(m[1]);
    }
    return urls;
  } catch (err) {
    console.warn(`[image] Bing HTML search esuat: ${err.message}`);
    return [];
  }
}

async function searchWikimediaCommons(query) {
  try {
    const res = await axios.get("https://commons.wikimedia.org/w/api.php", {
      params: {
        action: "query",
        generator: "search",
        gsrsearch: query,
        gsrnamespace: 6,
        prop: "imageinfo",
        gsrlimit: 20,
        iiprop: "url|size|mime|extmetadata",
        iiextmetadatafilter: "DateTimeOriginal",
        iiurlwidth: 800,
        format: "json",
      },
      headers: { "User-Agent": WIKI_UA },
      timeout: 15000,
    });
    const pages = Object.values(res.data?.query?.pages || {});
    return commonsPhotoCandidates(pages);
  } catch (err) {
    console.warn(`[image] Wikimedia Commons search esuat: ${err.message}`);
    return [];
  }
}

async function searchWikipediaImages(personName) {
  const names = [personName];
  const parts = personName.split(/\s+/);
  if (parts.length >= 2) names.push(parts[parts.length - 1]);

  const foundUrls = [];
  for (const name of names) {
    for (const lang of ["ro", "en"]) {
      try {
        const base = `https://${lang}.wikipedia.org/w/api.php`;
        const sr = await axios.get(base, {
          params: { action: "query", titles: name, prop: "pageimages", piprop: "original|thumbnail", pithumbsize: 800, format: "json" },
          headers: { "User-Agent": WIKI_UA },
          timeout: 10000,
        });
        const pages = Object.values(sr.data?.query?.pages || {});
        for (const p of pages) {
          const img = p.original?.source || p.thumbnail?.source;
          if (img && /^https?:\/\//.test(img) && !foundUrls.includes(img)) {
            foundUrls.push(img);
          }
        }
      } catch {}
    }
  }
  return foundUrls;
}

async function searchDuckDuckGo(query) {
  try {
    const res = await axios.get("https://duckduckgo.com/i.js", {
      params: { q: query, t: "images" },
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      timeout: 15000,
    });
    return (res.data.results || []).map((r) => r.image).filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
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
    if (!meta.width || !meta.height || meta.width < 320 || meta.height < 320) return null;
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
// referenceBuffer: poza oficiala a vorbitorului (Wikipedia). Candidatul e
// acceptat numai daca Gemini confirmă identitatea; fără referință sau verdict,
// nu postăm imaginea.
// Intoarce null daca imaginea respinsa (persoana diferita / nefaciala / moarta).
async function buildCandidate(imgUrl, personName, referenceBuffer, recentImages = []) {
  const dims = await downloadImage(imgUrl);
  if (!dims) return null;
  const pixels = await sharp(dims.buffer).rotate().resize(9, 8, { fit: "fill" }).grayscale().removeAlpha().raw().toBuffer();
  const visualHash = imageFingerprint(pixels);
  if (isRecentVisualDuplicate(visualHash, recentImages)) {
    console.log("[image] Fotografie recentă identică/aproape identică la alt URL; o sar înainte de Vision.");
    return null;
  }

  const verdict = referenceBuffer
    ? await verifyCandidate(referenceBuffer, dims.buffer)
    : await verifyPersonByName(personName, dims.buffer);
  if (!isVerifiedPersonImageAllowed({ hasReference: Boolean(referenceBuffer), identityByName: !referenceBuffer, ...verdict })) {
    console.log(`[image] Respins (identitatea nu a putut fi confirmată pentru ${personName}): ${imgUrl}`);
    return null;
  }

  console.log(`[image] Confirmat facial (${personName}): ${imgUrl}`);
  const faceBox = await getFaceBox(dims.buffer);
  const finalBuffer = await cropPortrait3x4(dims.buffer, faceBox);
  return {
    buffer: finalBuffer,
    sourceUrl: imgUrl,
    visualHash,
    note: faceBox
      ? "Imagine verificata facial (fara text vizibil), decupata centrat pe fata."
      : "Imagine decupata la 3:4 cu focalizare pe subiect.",
  };
}

// Prefer fresh, diverse verified candidates; never repeat a recent image as fallback.
export async function findImage(personOrTopic, articleTitle, articleImageUrl = null) {
  const recentImages = getRecentImages(IMAGE_HISTORY_DAYS());
  const usedKeys = recentImageKeys(recentImages);

  // 1. Referinta faciala + sanity-check: portretul trebuie sa contina o FATA.
  //    Pentru institutii/partide Wikipedia intoarce steme/logo-uri - fara fata
  //    nu are sens sa verificam candidati contra lor si nici sa postam asa ceva
  //    ca "portret". Fără o față de referință validă, nu alegem imagini din
  //    motoarele de căutare doar după nume sau titlul articolului.
  const reference = await fetchWikipediaReference(personOrTopic);
  let referenceBuffer = reference?.buffer || null;
  let referenceFaceBox = null;
  if (referenceBuffer) {
    referenceFaceBox = await getFaceBox(referenceBuffer);
    if (!referenceFaceBox) {
      console.log("[image] Referinta Wikipedia fara fata detectabila - nu o folosesc");
      // Detection failure must not short-circuit diversity or bypass identity checks.
      referenceBuffer = null;

    }
  }

  if (!referenceBuffer) console.warn(`[image] Nu există referință Wikipedia; voi accepta numai imagini în care Vision identifică explicit ${personOrTopic}.`);

  // 2. Candidati din motoare
  const exactPerson = `"${String(personOrTopic).replaceAll('"', "")}"`;
  const queries = [
    `${exactPerson} ${new Date().getUTCFullYear()}`,
    exactPerson,
    `${exactPerson} portret`,
    `${exactPerson} fotografie oficială`,
    `${exactPerson} România politician`,
    articleTitle ? articleTitle.slice(0, 100) : null,
  ].filter((q) => q && q.trim());

  const engines = [
    searchTavily,
    searchBingHtml,
    searchWikimediaCommons,
    searchWikipediaImages,
    searchDuckDuckGo,
    searchBingRss,
  ];
  const seenKeys = new Set(usedKeys);
  // Keep cost bounded while giving multiple providers a chance.
  const MAX_FACE_CHECKS = 12;
  let faceChecks = 0;

  // Try the publisher's own image first, but never trust it merely because
  // it is an og:image: it must pass the same positive face-identity check as
  // search results. This recovers relevant portraits without reviving random
  // screenshots, document scans, or unrelated article photos.
  if (isArticleImageCandidate({ speaker: personOrTopic, imageUrl: articleImageUrl }) && !seenKeys.has(imageIdentity(articleImageUrl))) {
    seenKeys.add(imageIdentity(articleImageUrl));
    faceChecks++;
    const candidate = await buildCandidate(articleImageUrl, personOrTopic, referenceBuffer, recentImages);
    if (candidate) {
      saveImage({ imageUrl: articleImageUrl, personOrTopic, visualHash: candidate.visualHash });
      return candidate;
    }
  }

  for (const q of queries) {
    // One bounded request per provider, in parallel; do not consume the whole
    // vision budget before later providers are even queried.
    const pools = await Promise.all(engines.map(async engine => {
      try {
        const imgs = await engine((engine === searchWikimediaCommons || engine === searchWikipediaImages) ? personOrTopic : q);
        console.log(`[image] ${engine.name} pentru "${q}": ${imgs.length} rezultate`);
        return imgs;
      } catch (err) {
        console.warn(`[image] Motor indisponibil: ${engine.name}`);
        return [];
      }
    }));
    const candidates = diverseImageCandidates(pools, seenKeys, Math.min(6, MAX_FACE_CHECKS - faceChecks));
    for (const imgUrl of candidates) {
      seenKeys.add(imageIdentity(imgUrl));
      faceChecks++;
      const candidate = await buildCandidate(imgUrl, personOrTopic, referenceBuffer, recentImages);
      if (candidate) {
        saveImage({ imageUrl: imgUrl, personOrTopic, visualHash: candidate.visualHash });
        return candidate;
      }
    }
    if (faceChecks >= MAX_FACE_CHECKS) break;
  }
  console.log(`[image] Verificați ${faceChecks} candidați pentru ${personOrTopic}; nicio imagine nouă confirmată`);
  if (referenceBuffer && referenceFaceBox && reference?.url && !usedKeys.has(imageIdentity(reference.url))) {
    const candidate = await buildCandidate(reference.url, personOrTopic, referenceBuffer, recentImages);
    if (candidate) {
      saveImage({ imageUrl: reference.url, personOrTopic, visualHash: candidate.visualHash });
      return candidate;
    }
  }
  console.warn("[image] Nicio imagine nouă verificată; omit fotografia, fără repetare automată.");
  return null;
}
