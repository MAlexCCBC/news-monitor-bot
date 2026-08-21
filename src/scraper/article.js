import axios from "axios";
import * as cheerio from "cheerio";

// Selectoare de continut per site, cu fallback generic. Nu mai depindem
// exclusiv de ele pentru data (folosim meta tags, mult mai fiabil).
const SITE_CONFIG = {
  "g4media.ro": {
    content: "div.entry-content, div.post-content, article",
  },
  "digi24.ro": {
    content: "div.article-body, div.articol-content, article",
  },
  "mediafax.ro": {
    content: "article, div.article-content, div#article-body",
  },
  "hotnews.ro": {
    content: "div.articol-continut, div#continutArticol, article",
  },
};

// Markeri de text care indica inceputul sectiunii de "recomandari" /
// "citeste si" / related — oprim extragerea de paragrafe cand le intalnim,
// pentru ca aceste site-uri baga link-uri recomandate CA paragrafe normale
// in acelasi container, nu intr-un div separat usor de exclus.
const STOP_MARKERS = [
  "citeste si",
  "citește și",
  "recomandarea video",
  "recomandari",
  "recomandări",
  "articole similare",
  "citeste continuarea",
  "citește continuarea",
  "vezi si",
  "vezi și",
];

function getSiteConfig(url) {
  const hostname = new URL(url).hostname.replace("www.", "");
  const key = Object.keys(SITE_CONFIG).find((domain) => hostname.includes(domain));
  return key ? SITE_CONFIG[key] : null;
}

// Citim data din meta tags standard (og:, article:published_time), care sunt
// mult mai stabile decat orice selector CSS vizibil, si le au toate site-urile mari.
function extractPublishDate($) {
  const candidates = [
    $('meta[property="article:published_time"]').attr("content"),
    $('meta[name="article:published_time"]').attr("content"),
    $('meta[property="og:article:published_time"]').attr("content"),
    $('time[datetime]').first().attr("datetime"),
    $('meta[name="date"]').attr("content"),
  ];
  const found = candidates.find((c) => c && c.trim().length > 0);
  return found || null; // ex: "2026-08-19T14:43:12+00:00"
}

// Header-uri complete de browser: unele site-uri (ex. hotnews.ro) resping
// intermitent request-urile cu doar User-Agent (403), mai ales de pe IP-uri
// de datacenter precum runner-ele GitHub Actions.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "ro-RO,ro;q=0.9,en;q=0.8",
  Referer: "https://www.google.com/",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
  "Upgrade-Insecure-Requests": "1",
};

// GET cu retry: erorile 403/429/5xx sunt de obicei temporare (rate limit /
// bot protection), deci reincercam cu backoff crescunt inainte sa renuntam.
async function getWithRetry(url, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios.get(url, {
        headers: BROWSER_HEADERS,
        timeout: 15000,
      });
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const retryable = status === 403 || status === 429 || status >= 500 || !status;
      if (!retryable || i === attempts - 1) throw err;
      const waitMs = 1500 * (i + 1);
      console.warn(`[scraper] ${status || "eroare retea"} la ${url} - reincerc in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}

export async function fetchArticle(url) {
  const { data: html } = await getWithRetry(url);

  const $ = cheerio.load(html);
  const config = getSiteConfig(url);

  const contentSelector = config?.content || "article, .entry-content, .post-content, main";

  let $content = $(contentSelector).first();
  if ($content.length === 0) $content = $("body"); // ultim fallback

  $content = $content.clone();
  $content.find("script, style, iframe, .ad, .advertisement, aside, nav").remove();

  const title = $("h1").first().text().trim() || $('meta[property="og:title"]').attr("content") || "";
  const isoDate = extractPublishDate($);

  // Extragem imaginea principala a articolului (og:image sau prima imagine din continut).
  // Aceasta e CELE MAI FIABILE sursa pentru imagine — articolul contine deja
  // persoana/corectă despre care se scrie.
  const ogImage = $('meta[property="og:image"]').attr("content") || $('meta[name="og:image"]').attr("content");
  let imageUrl = null;
  if (ogImage && /^https?:\/\//.test(ogImage)) {
    imageUrl = ogImage;
  } else {
    // Prima imagine din continutul articolului (excluzand icon-uri, logo-uri mici)
    $content.find("img").each((_, el) => {
      if (imageUrl) return;
      const src = $(el).attr("src") || $(el).attr("data-src") || "";
      if (!/^https?:\/\//.test(src)) return;
      const w = parseInt($(el).attr("width") || "0", 10);
      const h = parseInt($(el).attr("height") || "0", 10);
      // Ignoram imagini mici (logo, icon, avatar) — vrem poza de articol
      if (w > 0 && w < 150 && h > 0 && h < 150) return;
      imageUrl = src;
    });
  }

  const paragraphs = [];
  let stopped = false;

  $content.find("p, h2, h3").each((_, el) => {
    if (stopped) return;
    const t = $(el).text().trim().toLowerCase();

    if (STOP_MARKERS.some((marker) => t.includes(marker))) {
      stopped = true;
      return;
    }

    const originalText = $(el).text().trim();
    if (originalText.length > 20) paragraphs.push(originalText);
  });

  const contentText = paragraphs.join("\n\n");

  return {
    url,
    title,
    isoDate,
    content: contentText,
    imageUrl,
    fullTextForKeywordCheck: `${title}\n${contentText}`,
  };
}
