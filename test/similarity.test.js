import test from "node:test";
import assert from "node:assert/strict";

import { evaluate3ZoneSimilarity, selectSimilarityCandidate } from "../src/similarity/embedding.js";

test("generic Romanian headline overlap does not mark unrelated coverage as duplicate", () => {
  const result = evaluate3ZoneSimilarity(
    0.77,
    "Guvernul anunță sprijin pentru agricultori",
    "",
    "Guvernul anunță sancțiuni pentru companii",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, false);
  assert.equal(result.zone, "GRI (Permis)");
});

test("shared named subject and matching headline terms still catch likely duplicates", () => {
  const result = evaluate3ZoneSimilarity(
    0.77,
    "Bolojan anunță reforma pensiilor pentru 2026",
    "",
    "Bolojan anunță reforma sistemului de pensii în 2026",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, true);
  assert.equal(result.zone, "GRI (Duplicat confirmat)");
});

test("high semantic score with matching person and event terms still identifies a duplicate", () => {
  const result = evaluate3ZoneSimilarity(
    0.93,
    "Ilie Bolojan anunță reforma pensiilor din 2026",
    "",
    "Bolojan anunță reforma sistemului de pensii în 2026",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, true);
  assert.equal(result.zone, "VERDE");
});

test("high semantic similarity cannot alone block unrelated titles", () => {
  const result = evaluate3ZoneSimilarity(
    0.9,
    "Cutremur puternic în Japonia",
    "",
    "Rezultatele alegerilor locale din România",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, false);
});

test("a shared public figure without shared event terms is not enough", () => {
  const result = evaluate3ZoneSimilarity(
    0.91,
    "Bolojan anunță reforma pensiilor",
    "",
    "Bolojan vizitează fabrica din Iași după incendiu",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, false);
});

test("two overlapping title words cannot validate a high semantic score on their own", () => {
  const result = evaluate3ZoneSimilarity(
    0.91,
    "Consultanții analizează impactul taxelor asupra exporturilor agricole din România",
    "",
    "Economiștii analizează efectele taxelor asupra investițiilor străine în România",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, false);
});

test("names and a shared calendar year in the leads do not make unrelated headlines duplicates", () => {
  const result = evaluate3ZoneSimilarity(
    0.77,
    "Spital nou pentru orașul Iași",
    "În 2026, Ilie Bolojan și Cătălin Predoiu au discutat despre deschiderea spitalului.",
    "Reforma pensiilor și indexarea punctului",
    "În 2026, Ilie Bolojan și Cătălin Predoiu au discutat despre reforma pensiilor.",
    0.8
  );

  assert.equal(result.isDuplicate, false);
});

test("a shared politician name plus generic wording is not enough to mark unrelated news duplicate", () => {
  const result = evaluate3ZoneSimilarity(
    0.77,
    "Bolojan anunță noi reguli pentru pensii",
    "",
    "Bolojan anunță noi fonduri pentru spitale",
    "",
    0.8
  );

  assert.equal(result.isDuplicate, false);
});

test("a non-duplicate high score cannot hide a lower-scoring duplicate candidate", () => {
  const selected = selectSimilarityCandidate([
    { isDuplicate: false, score: 0.9, url: "https://example.com/unrelated" },
    { isDuplicate: true, score: 0.77, url: "https://example.com/same-event" },
  ]);

  assert.equal(selected.isDuplicate, true);
  assert.equal(selected.url, "https://example.com/same-event");
});
