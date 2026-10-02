import test from "node:test";
import assert from "node:assert/strict";

import {
  CORE_POLITICAL_KEYWORDS,
  CORE_ROMANIAN_POLITICAL_CONTEXT,
  hasStrongRomanianContext,
  hasMajorRomanianEmergencyContext,
  hasStrongRomanianPoliticalContext,
  isHistoricalRoundup,
  isForeignOnly,
  matchesKeywords,
} from "../src/filter/keywords.js";

test("short party acronyms do not match ordinary words or empty configuration", () => {
  assert.equal(matchesKeywords("Un restaurant inaugurat în București", ["AUR", "USR", "PNL", ""]).matched, false);
  assert.equal(matchesKeywords("AUR critică USR și PNL", ["AUR", "USR", "PNL"]).matchedKeywords.length, 3);
});

test("incidental Romanian political background cannot fast-track a foreign headline", () => {
  assert.equal(hasStrongRomanianPoliticalContext("Protestele elevilor din Franța: un liceu a fost incendiat\nNicușor Dan a anunțat consultări în Parlament.", ["Nicușor Dan"]), false);
  assert.equal(hasStrongRomanianPoliticalContext("Un restaurant cu ornamente aurii din București\nMinistrul a vizitat localul.", []), false);
  assert.equal(hasStrongRomanianPoliticalContext("Bolojan anunță consultări cu partidele după vot", ["Bolojan"]), true);
});

test("completed-run false admissions cannot regain the political fast path", () => {
  const schoolComparison = "Diferențe majore între școala japoneză și cea din România: Elevii nu sunt scoși la tablă, nu dau teze\nUn profesor de științe politice explică sistemul japonez.";
  assert.equal(matchesKeywords(schoolComparison, ["politic"]).matched, true);
  assert.equal(hasStrongRomanianPoliticalContext(schoolComparison, ["Nicușor Dan"]), false);

  const screensStory = "Mirabela Grădinaru: Trebuie să vorbim despre lumea în care cresc copiii noștri\nPartenera lui Nicușor Dan a discutat despre expunerea copiilor la ecrane.";
  assert.equal(matchesKeywords(screensStory, ["Nicușor Dan"]).matched, true);
  assert.equal(hasStrongRomanianPoliticalContext(screensStory, ["Nicușor Dan"]), false);

  const foreignInvestigation = "KimberlyGate: Congresmani democrați cer investigarea ambasadoarei SUA\nÎn alte știri, Bolojan a participat la ședința Guvernului.";
  assert.equal(matchesKeywords(foreignInvestigation, ["Bolojan", "Guvern"]).matched, true);
  assert.equal(hasStrongRomanianPoliticalContext(foreignInvestigation, ["Bolojan"]), false);
});

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

test("large coordinated vegetation-fire response reaches relevance review without political keywords", () => {
  const majorStory = "Incendii de vegetație în Caraș-Severin și Vâlcea: autoritățile au intervenit cu elicoptere Black Hawk și avioane Spartan";
  assert.equal(hasMajorRomanianEmergencyContext(majorStory), true);
  assert.equal(matchesKeywords(majorStory, CORE_POLITICAL_KEYWORDS).matched, false);
  assert.equal(
    hasMajorRomanianEmergencyContext("Incendiu de vegetație lângă o gospodărie; pompierii locali au stins focul."),
    false,
  );
  assert.equal(
    hasMajorRomanianEmergencyContext("Incendii de pădure în două județe; peste 170 de pompieri și salvatori au fost mobilizați de IGSU."),
    true,
  );
  assert.equal(
    hasMajorRomanianEmergencyContext("Accident rutier: elicopterul SMURD a transportat un rănit la spital."),
    false,
  );
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
  assert.equal(
    hasStrongRomanianPoliticalContext(
      "Pare că nu va trece guvernul Mureșan, spune unul dintre miniștrii propuși: E momentul să ne întoarcem la popor",
      ["Siegfried Mureșan", "Mureșan"],
    ),
    true,
  );
  assert.equal(
    hasStrongRomanianPoliticalContext(
      "Nicușor Dan: UNESCO a reiterat că tehnologia trebuie să servească omul",
      ["Nicușor Dan"],
    ),
    true,
  );
  assert.equal(
    hasStrongRomanianPoliticalContext(
      "Alexandru Nazare spune că România trebuie să ajusteze politica fiscală",
      [],
    ),
    true,
  );
});

test("Republic of Moldova domestic politics requires explicit Romanian relevance", () => {
  assert.equal(
    hasStrongRomanianPoliticalContext("Premierul Republicii Moldova anunță următoarea etapă politică", ["Bolojan"]),
    false,
  );
});

test("PNL and USR headlines count as Romanian political context and are not dropped as foreign-only", () => {
  for (const headline of ["PNL cere explicații despre decizie", "USR anunță o propunere politică"]) {
    assert.equal(hasStrongRomanianContext(headline, CORE_ROMANIAN_POLITICAL_CONTEXT), true);
    assert.equal(isForeignOnly(headline, CORE_ROMANIAN_POLITICAL_CONTEXT), false);
  }
});

test("historical roundups and archive retrospectives are excluded from current-news processing", () => {
  assert.equal(isHistoricalRoundup("Digistoria - cele mai importante evenimente petrecute pe 29 septembrie", "https://www.digi24.ro/digistoria/digistoria-cele-mai-importante-evenimente"), true);
  assert.equal(isHistoricalRoundup("Mediafax 35: 1996 – prima alternanță democratică", "https://www.mediafax.ro/mediafax-35/mediafax-35-1996"), true);
  assert.equal(isHistoricalRoundup("Grindeanu anunță o plângere penală", "https://hotnews.ro/politica/2360790"), false);
});

test("foreign-only security stories are identifiable without a Romanian link", () => {
  assert.equal(isForeignOnly("O dronă rusă a avariat un punct de frontieră ucrainean la granița cu Polonia", []), true);
  assert.equal(isForeignOnly("România convoacă ambasadorul Rusiei după incidentul de la graniță", []), false);
});
