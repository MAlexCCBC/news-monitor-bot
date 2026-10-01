import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { buildWordpressArticleHtml, fetchArticle, parseArticleHtml } from "../src/scraper/article.js";
import { articleFocus, cleanArticleContent } from "../src/scraper/clean-content.js";

test("G4Media leaf divs preserve the lead and do not import site furniture", () => {
  const lead = "Grupul parlamentar se întrunește astăzi pentru prezentarea programului.";
  const next = "Premierul desemnat participă la ședință și prezintă planurile sale.";
  const article = parseArticleHtml(`<h1>Ședință la PNL</h1>
    <p>Donează aici. Susține o presă liberă.</p>
    <div class="single__text"><div><div><strong>${lead}</strong></div><div>${next}</div></div>
      <p>Citește și: alt articol care nu este parte din această relatare</p>
      <p>Discuțiile continuă cu parlamentarii după prezentarea programului.</p></div>
    <p>Lasă un răspuns Anulează răspunsul</p>`, "https://www.g4media.ro/test.html");
  assert.ok(article.content.startsWith(lead));
  assert.equal(article.content.split(lead).length, 2);
  assert.ok(article.content.includes(next));
  assert.ok(article.content.includes("Discuțiile continuă"));
  assert.doesNotMatch(article.content, /Donează|Lasă un răspuns|alt articol/);
});

test("G4Media WordPress REST fallback keeps its title, full body, date, and featured image", () => {
  const article = parseArticleHtml(buildWordpressArticleHtml({
    date: "2026-09-27T19:00:00",
    title: { rendered: "Rogobete critică decizia PSD" },
    content: { rendered: "<p>Primul paragraf politic, suficient de lung pentru extragere.</p><p>Al doilea paragraf cu detalii.</p>" },
    _embedded: { "wp:featuredmedia": [{ source_url: "https://cdn.example/image.jpg?size=large&x=1" }] },
  }), "https://www.g4media.ro/test-rest-fallback.html");

  assert.equal(article.title, "Rogobete critică decizia PSD");
  assert.equal(article.isoDate, "2026-09-27T19:00:00");
  assert.match(article.content, /Primul paragraf politic/);
  assert.match(article.content, /Al doilea paragraf/);
  assert.equal(article.imageUrl, "https://cdn.example/image.jpg?size=large&x=1");
});

test("Digi24 article-story extraction excludes inline recommended-story carousel from article evidence", () => {
  const lead = "Protestele elevilor din Franța au ajuns în mai multe orașe, iar sute de licee sunt afectate.";
  const body = "Autoritățile franceze au anunțat măsuri după incidentele din timpul manifestațiilor.";
  const article = parseArticleHtml(`<main id="article-content"><article class="article-story">
    <h1>Protestele elevilor din Franța iau amploare</h1>
    <p>${lead}</p>
    <div class="swiper-widget-article"><article><p>Nicușor Dan anunță consultări după ce Guvernul Mureșan a picat la vot.</p></article></div>
    <p>${body}</p>
    <div class="article"><h5 class="article-title">Băsescu critică strategia lui Nicușor Dan în Parlament.</h5></div>
    <div class="video-player">{"video":"metadata"}</div>
  </article></main>`, "https://www.digi24.ro/stiri/externe/test-3972755");

  assert.equal(article.title, "Protestele elevilor din Franța iau amploare");
  assert.match(article.content, /Protestele elevilor din Franța/);
  assert.match(article.content, /Autoritățile franceze/);
  assert.doesNotMatch(article.content, /Nicușor Dan|Guvernul Mureșan|video/);
});

test("article scrape rejects a successful redirect to Digi24 homepage", async () => {
  const originalGet = axios.get;
  axios.get = async () => ({
    data: `<html><head><title>Digi24 - Stiri - Informația la putere!</title>
      <link rel="canonical" href="https://www.digi24.ro/"></head><body>
      <p>Articolul recomandat de pe prima pagină are suficient text pentru extracție.</p>
      </body></html>`,
    request: { res: { responseUrl: "https://www.digi24.ro/" } },
  });
  try {
    await assert.rejects(
      fetchArticle("https://www.digi24.ro/stiri/actualitate/politica/articol-123456"),
      /redirected article URL to homepage|generic homepage/,
    );
  } finally {
    axios.get = originalGet;
  }
});

test("article scrape allows a changed publisher slug when the article ID is retained", async () => {
  const originalGet = axios.get;
  axios.get = async () => ({
    data: `<html><head><title>Știre verificată</title>
      <link rel="canonical" href="https://www.mediafax.ro/politic/titlu-actualizat-123456"></head>
      <body><article><h1>Știre verificată</h1><div class="article-content">
      <p>Corpul real al articolului este disponibil și descrie în detaliu evenimentul politic.</p>
      </div></article></body></html>`,
    request: { res: { responseUrl: "https://www.mediafax.ro/politic/titlu-actualizat-123456" } },
  });
  try {
    const article = await fetchArticle("https://www.mediafax.ro/politic/titlu-vechi-123456");
    assert.equal(article.title, "Știre verificată");
    assert.match(article.content, /Corpul real al articolului/);
  } finally {
    axios.get = originalGet;
  }
});

test("stored donation and cookie blocks do not count as article evidence", () => {
  const content = cleanArticleContent("Donează aici. Susține o presă liberă.\n\nFuncționăm ca organizație non-profit, finanțăm proiectul.\n\nCONT LEI: RO89RZBR0000000\n\nDeschis la Raiffeisen Bank\n\nȘtirea propriu-zisă.\n\nSetarile tale privind cookie-urile nu permit afisarea.\n\nLasă un răspuns Anulează răspunsul\n\nAlte știri recomandate.");
  assert.equal(content, "Știrea propriu-zisă.");
});

test("Digi24 date and Google Discover furniture are removed before article-focus matching", () => {
  const lead = "Președintele Nicușor Dan s-a întâlnit la New York cu omologii săi din Senegal și Guineea.";
  const body = [
    "Data actualizării: 23.09.2026 09:06",
    "Urmărește Digi24 în Google Discover Adaugă Digi24 ca sursă preferată în Google",
    lead,
    "La întâlnire au discutat despre relațiile bilaterale și cooperarea economică.",
  ].join("\n\n");

  assert.equal(articleFocus(body), `${lead} La întâlnire au discutat despre relațiile bilaterale și cooperarea economică.`);
  assert.doesNotMatch(cleanArticleContent(body), /Data actualizării|Google Discover|sursă preferată/i);
});

test("article focus skips captions, dates, and a repeated headline before selecting the real lead", () => {
  const title = "„Decalogul” AUR pentru guvernare. Răspuns în oglindă față de PSD";
  const caption = "Ramona-Ioana Bruynseels, la Palatul Parlamentului. FOTO: Inquam Photos / Codrin Unici";
  const lead = "Parlamentarii AUR au prezentat prioritățile formațiunii, sub forma unui răspuns la cele 10 propuneri avansate anterior de PSD pentru un viitor program de guvernare, printre acestea fiind scăderea TVA și a impozitelor pe dividende.";
  const next = "Comisiile de specialitate din cadrul AUR au organizat o conferință cu temele Răspunsul AUR la cele 10 priorități propuse de PSD și PNRR și fonduri europene.";
  const body = [caption, title, "Publicat 22.09.2026 20:03", "Urmărește-ne în Google Discover", lead, next].join("\n\n");

  assert.equal(articleFocus(body, title), `${lead} ${next}`);
});
