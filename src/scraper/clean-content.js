// Remove site furniture from both newly scraped and already stored articles.
// Historical embeddings remain cached; cleaning their text costs no API calls.
const SITE_NOISE = /^(?:doneaz[ăa] aici|func[țţ]ion[ăa]m ca organiza[țţ]ie non-profit|cont (?:lei|eur|euro)\s*:|deschis la .*bank|set[ăa]rile tale privind cookie|-?\s*articolul continu[ăa] mai jos|adaug[ăa]-ne ca surs[ăa] preferat[ăa]|urm[ăa]re[șş]te-ne [îi]n discover|data (?:public[ăa]rii|actualiz[ăa]rii)\s*:|urm[ăa]re[șş]te .{0,80}în google discover\b|adaug[ăa] .{0,80}ca surs[ăa] preferat[ăa]|prima pagin[ăa]\s*[»>])/i;
const FOOTER = /^(?:las[ăa] un r[ăa]spuns|cele mai noi articole|articole similare)\b/i;
const FOCUS_NOISE = /^(?:publicat[ăa]?\b|actualizat[ăa]?\b|share\s*:|whatsapp icon\b|[·•]+$)/i;

function normalizedFocusText(text = "") {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function cleanArticleContent(content = "") {
  const paragraphs = [];
  for (const paragraph of content.split(/\n\s*\n/)) {
    const text = paragraph.replace(/\s+/g, " ").trim();
    if (FOOTER.test(text)) break;
    if (text && !SITE_NOISE.test(text)) paragraphs.push(text);
  }
  return paragraphs.join("\n\n");
}

export function articleFocus(content = "", title = "") {
  const normalizedTitle = normalizedFocusText(title);
  const paragraphs = cleanArticleContent(content).split(/\n\s*\n/).filter((paragraph) => {
    const text = paragraph.trim();
    const normalized = normalizedFocusText(text);
    if (text.length < 40 || FOCUS_NOISE.test(text)) return false;
    if (normalizedTitle && normalized === normalizedTitle) return false;
    // Photo captions/bylines and duplicated headline blocks are common before
    // the actual lead on HotNews and must not consume the limited focus window.
    if (/\b(?:sursa foto|credit foto|foto:|fotografie de)/i.test(text)) return false;
    return true;
  });
  return paragraphs.slice(0, 2).join(" ").slice(0, 1000);
}
