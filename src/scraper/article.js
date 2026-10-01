import axios from "axios";
import * as cheerio from "cheerio";
import { cleanArticleContent } from "./clean-content.js";
import { parsePublicationDate } from "../filter/publication-date.js";

// Selectoare de continut per site, cu fallback generic. Nu mai depindem
// exclusiv de ele pentru data (folosim meta tags, mult mai fiabil).
const SITE_CONFIG = {
  "g4media.ro": {
    content: "div.single__text, div.entry-content, div.post-content, article",
  },
  "digi24.ro": {
    content: "article.article-story, div.article-body, div.articol-content, article",
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
  const key = Object.keys(SITE_CONFIG).find((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  return key ? SITE_CONFIG[key] : null;
}

// Citim data din meta tags standard (og:, article:published_time), care sunt
// mult mai stabile decat orice selector CSS vizibil, si le au toate site-urile mari.
function extractPublicationMetadata($, url, title) {
  const candidates = [];
  const add = (value, source) => {
    const timestamp = parsePublicationDate(value);
    if (timestamp !== null) candidates.push({ value: value.trim(), source, timestamp });
  };
  $('meta[property="article:published_time"], meta[name="article:published_time"], meta[property="og:article:published_time"], meta[itemprop="datePublished"], meta[name="datePublished"]').each((_, el) => add($(el).attr("content"), "publication_meta"));
  const normalizedTitle = (value) => String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/^video\s+/, "").replace(/[^a-z0-9]/g, "");
  const sameUrl = (value) => {
    if (!value) return false;
    try {
      const candidate = new URL(typeof value === "object" ? value?.["@id"] : value, url);
      const requested = new URL(url);
      return candidate.hostname.replace(/^www\./, "") === requested.hostname.replace(/^www\./, "") && candidate.pathname.replace(/\/+$/, "") === requested.pathname.replace(/\/+$/, "");
    } catch { return false; }
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).text()); } catch { return; }
    const nodes = Array.isArray(data) ? data : [data, ...(Array.isArray(data?.["@graph"]) ? data["@graph"] : [])];
    for (const node of nodes) {
      const types = [].concat(node?.["@type"] || []);
      if (!types.some((type) => /^(?:NewsArticle|Article|ReportageNewsArticle|AnalysisNewsArticle|BlogPosting)$/.test(type))) continue;
      // Recommendation dates cannot revive an archived story.
      if (!sameUrl(node.url || node.mainEntityOfPage || node["@id"]) &&
          (!title || normalizedTitle(node.headline) !== normalizedTitle(title))) continue;
      add(node.datePublished, "structured_datePublished");
    }
  });
  $('article time[pubdate][datetime], article [itemprop="datePublished"]').each((_, el) => {
    if ($(el).closest("aside, .related-posts, .swiper-widget-article, .article").length) return;
    add($(el).attr("datetime") || $(el).attr("content"), "article_datePublished");
  });
  // Exclude dateModified and arbitrary time elements. Conflicting publication
  // sources use the oldest date, so an update cannot make an old story new.
  candidates.sort((a, b) => a.timestamp - b.timestamp);
  return { isoDate: candidates[0]?.value || null, publicationDateSource: candidates[0]?.source || null };
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
  try {
    const response = await getWithRetry(url);
    assertArticleResponseMatchesRequest(response, url);
    const { data: html } = response;
    return parseArticleHtml(html, url);
  } catch (error) {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host !== "g4media.ro" || error.response?.status !== 403) throw error;

    // G4Media's public WordPress REST API is often reachable from Actions even
    // when its HTML frontend returns a datacenter-IP 403. Use the publisher's
    // own public article representation; don't proxy or evade access controls.
    const slug = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    const endpoint = "https://www.g4media.ro/wp-json/wp/v2/posts?slug=" +
      encodeURIComponent(slug) + "&_embed=wp:featuredmedia";
    try {
      const { data } = await axios.get(endpoint, {
        headers: BROWSER_HEADERS,
        timeout: 15000,
      });
      const post = Array.isArray(data) ? data[0] : null;
      if (!post?.content?.rendered || !post?.title?.rendered) {
        throw new Error("endpoint-ul public nu a returnat conținutul articolului");
      }
      console.warn(`[scraper] Frontend G4Media a răspuns 403; articol extras prin REST-ul public (${url})`);
      return parseArticleHtml(buildWordpressArticleHtml(post), url);
    } catch (fallbackError) {
      console.error(`[scraper] REST G4Media indisponibil după 403 (${url}): ${fallbackError.message}`);
      throw error;
    }
  }
}

function assertArticleResponseMatchesRequest(response, requestedUrl) {
  const requested = new URL(requestedUrl);
  const html = response?.data;
  const $ = cheerio.load(typeof html === "string" ? html : "");
  const resolvedUrl = response?.request?.res?.responseUrl || response?.request?.responseURL;
  const canonicalUrl = $('link[rel="canonical"]').attr("href") ||
    $('meta[property="og:url"]').attr("content");

  for (const candidate of [resolvedUrl, canonicalUrl]) {
    if (!candidate) continue;
    let resolved;
    try {
      resolved = new URL(candidate, requested);
    } catch {
      continue;
    }

    if (resolved.hostname.replace(/^www\./, "") !== requested.hostname.replace(/^www\./, "")) continue;
    const resolvedPath = resolved.pathname.replace(/\/+$/, "");
    if (!resolvedPath) {
      throw new Error(`publisher redirected article URL to homepage: ${requestedUrl}`);
    }

    // Publishers may update a headline slug while retaining the same numeric
    // article ID. That is a legitimate canonical redirect; a different ID is not.
    const requestedId = requested.pathname.match(/(\d{5,})(?:\D*)$/)?.[1];
    const resolvedId = resolved.pathname.match(/(\d{5,})(?:\D*)$/)?.[1];
    if (requestedId && resolvedId && requestedId !== resolvedId) {
      throw new Error(`publisher returned a different article ID (${resolvedId}) for ${requestedUrl}`);
    }
  }

  const pageTitle = ($("title").first().text() || $("h1").first().text() || "").trim();
  if (/^Digi24\s*[-|–]\s*Știri\s*[-|–]\s*Informația la putere!?$/i.test(pageTitle)) {
    throw new Error(`publisher returned its generic homepage instead of the requested article: ${requestedUrl}`);
  }
}

export function buildWordpressArticleHtml(post) {
  const featuredImage = post._embedded?.["wp:featuredmedia"]?.[0]?.source_url;
  const imageMeta = featuredImage
    ? '<meta property="og:image" content="' + String(featuredImage).replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '">'
    : "";
  return '<html><head><meta property="article:published_time" content="' +
    String(post.date_gmt ? `${post.date_gmt}Z` : post.date || "").replace(/"/g, "&quot;") + '">' + imageMeta +
    '</head><body><article><h1>' + post.title.rendered +
    '</h1><div class="single__text">' + post.content.rendered +
    '</div></article></body></html>';
}

export function parseArticleHtml(html, url) {
  const $ = cheerio.load(html);
  const config = getSiteConfig(url);

  const contentSelector = config?.content || "article, .entry-content, .post-content, main";

  // Comma selectors return DOM order, not priority. Prefer the actual article
  // body over its enclosing article and over recommendation cards.
  const selector = contentSelector.split(",").find((part) => $(part.trim()).length);
  let $content = selector ? $(selector.trim()).first() : $([]);
  if ($content.length === 0) $content = $("body"); // ultim fallback

  $content = $content.clone();
  $content.find("script, style, iframe, .ad, .advertisement, aside, nav, .sgb-google-buttons, #mediakitPlayer, [data-platform], .related-posts, .swiper-widget-article, .video-player, .gdpr-placeholder, .gdpr-social-media, .article-story .article").remove();

  const title = $("h1").first().text().trim() || $('meta[property="og:title"]').attr("content") || "";
  const { isoDate, publicationDateSource } = extractPublicationMetadata($, url, title);

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

  $content.find("p, h2, h3, li, div").each((_, el) => {
    if (stopped) return;
    // WordPress pasted text may live in leaf divs. Do not add ancestor divs
    // as well, which would duplicate the same paragraphs in the embedding.
    if (el.tagName === "div" && $(el).find("p, h2, h3, li, div").length) return;
    const t = $(el).text().trim().toLowerCase();

    if (STOP_MARKERS.some((marker) => t.startsWith(marker))) {
      // Inline recommendations are often followed by the rest of the story.
      // A recommendations heading, on the other hand, starts a footer section.
      stopped = el.tagName === "h2" || el.tagName === "h3";
      return;
    }

    const originalText = $(el).text().trim();
    if (originalText.length > 20) paragraphs.push(originalText);
  });

  const contentText = cleanArticleContent(paragraphs.join("\n\n"));
  console.log(`[scraper] Articol extras: ${contentText.length} caractere, ${paragraphs.length} paragrafe, ${stopped ? "oprit la marker de conținut recomandat" : "fără marker de oprire"} (${url})`);

  return {
    url,
    title,
    isoDate,
    publicationDateSource,
    content: contentText,
    imageUrl,
    fullTextForKeywordCheck: `${title}\n${contentText}`,
  };
}
