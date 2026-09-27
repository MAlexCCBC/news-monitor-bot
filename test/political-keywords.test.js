import test from "node:test";
import assert from "node:assert/strict";

import {
  CORE_POLITICAL_KEYWORDS,
  CORE_ROMANIAN_POLITICAL_CONTEXT,
  hasStrongRomanianContext,
  hasStrongRomanianPoliticalContext,
  isForeignOnly,
  matchesKeywords,
} from "../src/filter/keywords.js";

test("core political topics stay included even if external KEYWORDS configuration omits them", () => {
  for (const headline of [
    "Mureșan vorbește despre proiectul de lege",
    "Bolojan anunță o reformă administrativă",
    "PNL critică decizia guvernului",
    "USR cere o anchetă parlamentară",
    "Dezbatere politică despre buget",
  ]) {
    assert.equal(matchesKeywords(headline, CORE_POLITICAL_KEYWORDS).matched, true, headline);
  }
});

test("Romanian politician mentions alone do not bypass political relevance classification", () => {
  assert.equal(
    hasStrongRomanianPoliticalContext("Victor Ponta în doliu! Mama lui a murit", ["Victor Ponta", "Ponta"]),
    false,
  );
  assert.equal(
    hasStrongRomanianPoliticalContext("Un tată român a fost reclamat în Italia", ["Victor Ponta"]),
    false,
  );
});

test("clear Romanian political headlines use the cheap political-context fast path", () => {
  assert.equal(
    hasStrongRomanianPoliticalContext(
      "Alexandru Rogobete, PSD, critici la adresa lui Fritz la Timișoara",
      ["Dominic Fritz", "Fritz"],
    ),
    true,
  );
});

test("PNL and USR headlines count as Romanian political context and are not dropped as foreign-only", () => {
  for (const headline of ["PNL cere explicații despre decizie", "USR anunță o propunere politică"]) {
    assert.equal(hasStrongRomanianContext(headline, CORE_ROMANIAN_POLITICAL_CONTEXT), true);
    assert.equal(isForeignOnly(headline, CORE_ROMANIAN_POLITICAL_CONTEXT), false);
  }
});
