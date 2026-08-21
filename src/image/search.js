import axios from "axios";
import sharp from "sharp";
import { getRecentImages, saveImage } from "../storage/db.js";

const TAVILY_KEY = () => process.env.TAVILY_API_KEY;
const GEMINI_KEY = () => process.env.GEMINI_API_KEY;
const IMAGE_HISTORY_DAYS = () => Number(process.env.IMAGE_HISTORY_DAYS || 7);

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

async function cropTo3x4(buffer) {
  const meta = await sharp(buffer).metadata();
  const targetRatio = 3 / 4;

  if (meta.width / meta.height > targetRatio) {
    const cropWidth = Math.round(meta.height * targetRatio);
    return sharp(buffer)
      .resize(cropWidth, meta.height, {
        fit: "cover",
        position: sharp.strategy.attention,
      })
      .toBuffer();
  }

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

export async function processCandidate(imgUrl) {
  const dims = await getImageDimensions(imgUrl);
  if (!dims) return null;
  if (!dims.width || !dims.height || dims.width < 100 || dims.height < 100) return null;

  let finalBuffer = dims.buffer;
  let note = "Imagine gasita direct in raportul corect (3:4 sau 9:16).";

  if (!isAcceptableRatio(dims.width, dims.height)) {
    finalBuffer = await cropTo3x4(dims.buffer);
    note = "Imagine decupata la 3:4 cu focalizare pe subiect.";
  }

  return { buffer: finalBuffer, sourceUrl: imgUrl, note };
}

export async function findImage(personOrTopic, articleTitle) {
  const recentImages = getRecentImages(IMAGE_HISTORY_DAYS());
  const usedUrls = new Set(recentImages.map((i) => i.image_url));
  const usedMeta = new Map(recentImages.map((i) => [i.image_url, i]));

  // Cautare dinamica prin motoare (Tavily, DuckDuckGo, Bing) combinata cu contextul vorbitorului
  const queries = [
    `${personOrTopic} Romania stiri`,
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
        if (usedUrls.has(imgUrl)) continue;

        const processed = await processCandidate(imgUrl);
        if (processed) {
          saveImage({ imageUrl: imgUrl, personOrTopic });
          return processed;
        }
      }
    }
  }

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

  return null;
}