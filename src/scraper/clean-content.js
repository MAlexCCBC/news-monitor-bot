// Remove site furniture from both newly scraped and already stored articles.
// Historical embeddings remain cached; cleaning their text costs no API calls.
const SITE_NOISE = /^(?:doneaz[ăa] aici|func[țţ]ion[ăa]m ca organiza[țţ]ie non-profit|cont (?:lei|eur|euro)\s*:|deschis la .*bank|set[ăa]rile tale privind cookie|-?\s*articolul continu[ăa] mai jos|adaug[ăa]-ne ca surs[ăa] preferat[ăa]|urm[ăa]re[șş]te-ne [îi]n discover)/i;
const FOOTER = /^(?:las[ăa] un r[ăa]spuns|cele mai noi articole|articole similare)\b/i;

export function cleanArticleContent(content = "") {
  const paragraphs = [];
  for (const paragraph of content.split(/\n\s*\n/)) {
    const text = paragraph.replace(/\s+/g, " ").trim();
    if (FOOTER.test(text)) break;
    if (text && !SITE_NOISE.test(text)) paragraphs.push(text);
  }
  return paragraphs.join("\n\n");
}

export function articleFocus(content = "") {
  return cleanArticleContent(content).split(/\n\s*\n/).slice(0, 2).join(" ").slice(0, 1000);
}
