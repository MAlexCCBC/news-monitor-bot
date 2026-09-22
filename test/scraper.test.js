import test from "node:test";
import assert from "node:assert/strict";
import { parseArticleHtml } from "../src/scraper/article.js";
import { cleanArticleContent } from "../src/scraper/clean-content.js";

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
