import axios from "axios";
import sharp from "sharp";
import { getRecentImages, saveImage } from "../storage/db.js";
import { getFaceBox, verifyCandidate } from "./vision.js";

const TAVILY_KEY = () => process.env.TAVILY_API_KEY;
const IMAGE_HISTORY_DAYS = () => Number(process.env.IMAGE_HISTORY_DAYS || 7);

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
  const nameWords = norm(personName).split(/\s+/).filter(Boolean);
  if (nameWords.length === 0) return false;
  if (nameWords.length === 1) return titleNorm === nameWords[0];
  const titleWords = new Set(titleNorm.split(/[\s\-–—]+/));
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
          params: { action: "query", list: "search", srsearch: name, srlimit: 3, format: "json" },
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
  const key = TAVILY_KEY();
  if (!key) return [];
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
    console.warn(`[image] Tavily search indisponibil (${err.response?.status || err.message}), trecem la urmatorul motor...`);
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
        iiprop: "url|size",
        iiurlwidth: 800,
        format: "json",
      },
      headers: { "User-Agent": WIKI_UA },
      timeout: 15000,
    });
    const pages = Object.values(res.data?.query?.pages || {});
    return pages
      .map((p) => p.imageinfo?.[0]?.thumburl || p.imageinfo?.[0]?.url)
      .filter((u) => u && /^https?:\/\//.test(u) && /\.(jpe?g|png|webp)/i.test(u));
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

// Verifica daca numele persoanei apare in URL-ul imaginii (ex:
// "Portret_George_Simion.jpg"). Cand modelul de viziune respinge o poza DAR
// numele e chiar in fisier, cel mai probabil e o respingere falsa a unui
// model slab (Gemma) si o acceptam cu avertisment.
// Strict: TOATE cuvintele semnificative ale numelui trebuie prezente, iar
// URL-ul sa nu indice continut non-persona (cladiri, galerii, monumente) -
// altfel o poza cu "casa-mita-biciclista" trecea ca portret.
function urlMentionsPerson(imgUrl, personName) {
  try {
    const decoded = decodeURIComponent(imgUrl).toLowerCase().replace(/[-_]/g, " ");
    const tokens = personName
      .toLowerCase()
      .split(/\s+/)
      .filter((tok) => tok.length > 3);
    if (tokens.length === 0) return false;
    if (!tokens.every((tok) => decoded.includes(tok))) return false;

    const NON_PERSON = /\b(cladire|cladiri|casa|caselor|monument|statuie|galerie|galerie foto|arhitectura|strada|bulevard|cartier|oras|localitate|harta)\b/;
    return !NON_PERSON.test(decoded);
  } catch {
    return false;
  }
}

// Descarca, verifica si decupeaza un candidat.
// referenceBuffer: poza oficiala a vorbitorului (Wikipedia). Daca exista,
// candidatul e acceptat DOAR daca Gemini confirma aceeasi persoana.
// Intoarce null daca imaginea respinsa (persoana diferita / nefaciala / moarta).
async function buildCandidate(imgUrl, personName, referenceBuffer) {
  const dims = await downloadImage(imgUrl);
  if (!dims) return null;

  if (referenceBuffer) {
    const verdict = await verifyCandidate(referenceBuffer, dims.buffer);

    // Respingere pt. text vizibil (watermark, logo post TV, titluri, subtitrari)
    if (verdict.hasText === true) {
      console.log(`[image] Respins (are text vizibil in imagine): ${imgUrl}`);
      return null;
    }

    if (verdict.samePerson === false && urlMentionsPerson(imgUrl, personName)) {
      console.log(`[image] Model a zis NU DAR numele apare in URL - accept (${personName}): ${imgUrl}`);
    } else if (verdict.samePerson === false) {
      console.log(`[image] Respins (NU e ${personName}): ${imgUrl}`);
      return null;
    } else if (verdict.samePerson === null) {
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
      ? "Imagine verificata facial (fara text vizibil), decupata centrat pe fata."
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
//  3. Fiecare candidat e verificat facial + anti-text contra referintei, apoi
//     cropuit centrat pe fata. Primul confirmat castiga; pozele folosite in
//     ultimele IMAGE_HISTORY_DAYS zile sunt sarite (fara repetitii).
//  4. Nimic nou verificat => portretul Wikipedia (daca nu e repetat recent),
//     apoi reutilizare LRU, iar portretul Wikipedia repetat e ultima rezerva.
export async function findImage(personOrTopic, articleTitle) {
  const recentImages = getRecentImages(IMAGE_HISTORY_DAYS());
  const usedUrls = new Set(recentImages.map((i) => i.image_url));
  const usedMeta = new Map(recentImages.map((i) => [i.image_url, i]));

  // 1. Referinta faciala + sanity-check: portretul trebuie sa contina o FATA.
  //    Pentru institutii/partide Wikipedia intoarce steme/logo-uri - fara fata
  //    nu are sens sa verificam candidati contra lor si nici sa postam asa ceva
  //    ca "portret". In acest caz renuntam la referinta (candidatii vor fi
  //    acceptati pe contextul numelui) si la fallback-ul cu portretul.
  const reference = await fetchWikipediaReference(personOrTopic);
  let referenceBuffer = reference?.buffer || null;
  let referenceFaceBox = null;
  if (referenceBuffer) {
    referenceFaceBox = await getFaceBox(referenceBuffer);
    if (!referenceFaceBox) {
      console.log("[image] Referinta Wikipedia fara fata detectabila - nu o folosesc");
      referenceBuffer = null;
    }
  }

  // 2. Candidati din motoare
  const queries = [
    `${personOrTopic} Romania stiri`,
    personOrTopic,
    articleTitle ? articleTitle.slice(0, 80) : null,
  ].filter((q) => q && q.trim());

  const engines = [
    searchTavily,
    searchBingHtml,
    searchWikimediaCommons,
    searchWikipediaImages,
    searchDuckDuckGo,
    searchBingRss,
  ];
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
      let imgs = [];
      try {
        imgs = await engine(q);
      } catch (err) {
        console.warn(`[image] Eroare la apel motor imagini: ${err.message}`);
        continue;
      }
      for (const imgUrl of imgs) {
        if (!imgUrl || typeof imgUrl !== "string") continue;
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
    // 4. Nimic nou verificat. ORDINEA conteaza ca sa evitam repetarile:
    //    a) daca portretul Wikipedia NU a fost folosit recent -> il folosim
    //       (persoana corecta garantat);
    //    b) daca A fost folosit recent (ex: acelasi politician la doua stiri in
    //       aceeasi zi) -> incercam intai reutilizarea LRU a altor poze vechi
    //       ale lui, ca sa nu repetam identic;
    //    c) abia daca nu exista nimic altceva, repetam si portretul Wikipedia
    //       (mai bine o poza repetata decat una gresita sau deloc).
    const wikiRecentlyUsed = reference?.url ? usedUrls.has(reference.url) : false;

    // Reutilizare LRU din istoricul recent (poze vechi care au reaparut in
    // rezultatele de azi; sortate ca sa luam cea mai putin folosita).
    const reusePool = [];
    for (const imgUrl of seen) {
      const meta = usedMeta.get(imgUrl);
      if (meta) reusePool.push({ url: imgUrl, lastUsed: meta.last_used, usedCount: meta.used_count });
    }
    reusePool.sort((a, b) => a.lastUsed - b.lastUsed || a.usedCount - b.usedCount);

    if (referenceBuffer && !wikiRecentlyUsed) {
      const processed = {
        buffer: await cropPortrait3x4(referenceBuffer, referenceFaceBox),
        sourceUrl: reference.url || null,
        note: "Portret oficial (Wikipedia) - nu am gasit poze noi verificate facial.",
      };
      saveImage({ imageUrl: reference.url || "", personOrTopic });
      console.log("[image] Fallback: folosesc portretul Wikipedia al vorbitorului");
      return processed;
    }

    for (const { url } of reusePool) {
      const candidate = await buildCandidate(url, personOrTopic, referenceBuffer);
      if (candidate) {
        saveImage({ imageUrl: url, personOrTopic });
        return candidate;
      }
    }

    if (referenceBuffer && wikiRecentlyUsed) {
      const processed = {
        buffer: await cropPortrait3x4(referenceBuffer, referenceFaceBox),
        sourceUrl: reference.url || null,
        note: "Portret oficial (Wikipedia) - reutilizat; nu am gasit alta poza verificata.",
      };
      saveImage({ imageUrl: reference.url || "", personOrTopic });
      console.log("[image] Ultima rezerva: repetau portretul Wikipedia (deja folosit recent)");
      return processed;
    }
  }

  return winner;
}
