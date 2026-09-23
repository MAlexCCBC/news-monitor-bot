import test from "node:test";
import assert from "node:assert/strict";
import { parseArticleHtml } from "../src/scraper/article.js";
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
