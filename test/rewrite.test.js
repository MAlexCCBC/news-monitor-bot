import test from "node:test";
import assert from "node:assert/strict";

import { isCompleteRewrite, validateRewriteGrounding } from "../src/ai/rewrite.js";

const completePost = `📰 TITLU DE TEST\nContextul articolului.\n\n📌 Ideile principale:\n• 🔹 Primul punct complet.\n• 🔹 Al doilea punct complet.\n• 🔹 Al treilea punct complet.\nOficialul a declarat că situația continuă.\n💬 Ce părere aveți?\n\n👇 Așteptăm opinia ta în comentarii!`;

test("rewrite is complete only with a natural stop, three points, and the final footer", () => {
  assert.equal(isCompleteRewrite(completePost, "STOP"), true);
  assert.equal(isCompleteRewrite(completePost.slice(0, -20), "STOP"), false);
  assert.equal(isCompleteRewrite(completePost.replace("• 🔹 Al treilea punct complet.\n", ""), "STOP"), false);
  assert.equal(isCompleteRewrite(completePost, "MAX_TOKENS"), false);
});

test("rewrite grounding rejects a fabricated quote, unrelated person, or unsupported number", () => {
  const source = "DIICOT îl cercetează pe Călin Georgescu pentru înșelăciune. Călin Georgescu a fost dus la Tribunal.";
  const output = `Călin Georgescu este cercetat.\n„Voi vota Guvernul Mureșan mâine 233”`;
  const failures = validateRewriteGrounding(output, source);
  assert.ok(failures.some((failure) => failure.includes("citatul")));
  assert.ok(failures.some((failure) => failure.includes("233")));
});

test("rewrite grounding accepts an exact source quote and names present in the source", () => {
  const source = "Sorin Grindeanu a declarat: «Nu am de ce să mă ascund». Liderul PSD a vorbit luni.";
  const output = `Sorin Grindeanu a făcut declarații.\n„Nu am de ce să mă ascund”, Sorin Grindeanu, lider PSD.`;
  assert.deepEqual(validateRewriteGrounding(output, source), []);
});

test("rewrite grounding does not mistake institutions, places, and venues for unsupported people", () => {
  const source = "BNR a analizat trecerea la zona euro. Mugur Isărescu a vorbit despre inflație.";
  const output = "Banca Națională a analizat trecerea la zona euro. Guvernatorul Băncii Naționale, Mugur Isărescu, a vorbit despre inflație. Camera Deputaților a găzduit evenimentul, iar delegația s-a întâlnit la Vila Kram din Republica Cehă.";
  assert.deepEqual(validateRewriteGrounding(output, source), []);
});

test("rewrite grounding still rejects unsupported person names and mismatched numbers", () => {
  const source = "Sindicatul a anunțat că 6.030 de instituții nu au raportat date.";
  const output = "Conform Ministerului Muncii, 6.000 de instituții nu au raportat date. Siegfried Mureșan a comentat situația.";
  const failures = validateRewriteGrounding(output, source);
  assert.ok(!failures.some((failure) => failure.includes("Ministerului Muncii")));
  assert.ok(failures.some((failure) => failure.includes("Siegfried Mureșan")));
  assert.ok(failures.some((failure) => failure.includes("6.000")));
});
