import test from "node:test";
import assert from "node:assert/strict";

import { formatApprovalText } from "../src/telegram/approval-messages.js";

test("link similarity prompt labels the link-to-link comparison and exposes both clickable URLs", () => {
  const text = formatApprovalText({
    kind: "article",
    article: { title: "Știrea nouă" },
    url: "https://news.example/current?id=1&x=2",
    comparisonTitle: "Știrea anterioară",
    comparisonUrl: "https://news.example/previous",
    similarity: 0.91,
  });

  assert.match(text, /Comparație între link-uri/);
  assert.match(text, /Posibil duplicat · 91%/);
  // A legacy item without a saved AI verdict must not claim Gemini decided
  // either way.
  assert.match(text, /verdictul Gemini nu este disponibil/);
  assert.doesNotMatch(text, /Gemini .* a confirmat|Gemini .* a respins/);
  assert.doesNotMatch(text, /apropierea vectorilor/);
  assert.match(text, /href="https:\/\/news\.example\/current\?id=1&amp;x=2"/);
  assert.match(text, /<a href="https:\/\/news\.example\/current\?id=1&amp;x=2">https:\/\/news\.example\/current\?id=1&amp;x=2<\/a>/);
  assert.match(text, /<a href="https:\/\/news\.example\/previous">https:\/\/news\.example\/previous<\/a>/);
  assert.doesNotMatch(text, /Deschide știrea/);
  assert.match(text, /expiră în 12 ore/);
});

test("legacy link approvals recover their comparison URL from the saved similarity result", () => {
  const text = formatApprovalText({
    kind: "article",
    article: { title: "Știrea nouă" },
    url: "https://news.example/current",
    simResult: { similarUrl: "https://news.example/previous" },
    similarity: 0.91,
  });

  assert.match(text, /https:\/\/news\.example\/previous/);
  assert.doesNotMatch(text, /link indisponibil/);
});

test("legacy AI text retries no longer display a similarity gate", () => {
  const text = formatApprovalText({
    kind: "ai_text",
    article: { title: "Articol curent" },
    url: "https://news.example/current",
    comparisonTitle: "Text AI anterior",
    comparisonUrl: "https://news.example/previous",
    similarity: 0.88,
    formattedPost: "Previzualizare text",
  });

  assert.match(text, /Text pregătit pentru trimitere/);
  assert.match(text, /reîncerca trimiterea/);
  assert.doesNotMatch(text, /pare similar|Comparație|88%|news\.example\/previous/);
});

test("cross-embedding AI duplicate is not misleadingly displayed as semantic similarity 0%", () => {
  const text = formatApprovalText({
    kind: "article",
    url: "https://news.example/current",
    article: { title: "Articol nou" },
    comparisonUrl: "https://news.example/old",
    comparisonTitle: "Articol anterior",
    similarity: 0,
    simResult: { similarityBasis: "ai_cross_embedding" },
  });
  assert.match(text, /confirmat prin AI/);
  assert.doesNotMatch(text, /0%/);
});

test("an uncertain AI comparison is clearly presented for manual review", () => {
  const text = formatApprovalText({
    kind: "article", url: "https://news.example/current",
    article: { title: "Articol nou" }, comparisonUrl: "https://news.example/old",
    comparisonTitle: "Articol anterior", similarity: 0,
    simResult: { similarityBasis: "ai_cross_embedding", aiVerdict: "uncertain", aiSuggestedVerdict: "same_report", aiSimilarityProbability: 96, aiRationale: "Ambele redau aceeași declarație despre alegerile anticipate și rectificarea bugetară.", aiChecks: [{ model: "gemini-test", validatedVerdict: "uncertain", duplicateProbability: 96, reason: "Ambele redau aceeași declarație despre alegerile anticipate." }] },
  });
  assert.match(text, /Verificare manuală/);
  assert.match(text, /96% estimare Gemini/);
  // The concrete reason from the model is the useful part of this card.
  assert.match(text, /Motivul: Ambele redau aceeași declarație/);
  assert.match(text, /Verificări păstrate: gemini-test: uncertain \(96%\)/);
  assert.doesNotMatch(text, /scor semantic 0%/);
});

test("manual review distinguishes Gemini's negative suggestion from an evidence-validation downgrade", () => {
  const text = formatApprovalText({
    kind: "article",
    url: "https://example.com/incoming",
    comparisonUrl: "https://example.com/candidate",
    comparisonTitle: "Articol candidat",
    similarity: 0.88,
    simResult: {
      aiVerdict: "uncertain",
      aiSuggestedVerdict: "different",
      aiSimilarityProbability: 0,
      aiRationale: "Cele două articole descriu evenimente diferite.",
      aiValidationReason: "Lipsește fișa faptului central necesară pentru a justifica diferența.",
      aiChecks: [{
        model: "gemini-test", verdict: "different", validatedVerdict: "uncertain",
        duplicateProbability: 0, reason: "Evenimente diferite.",
        validationReason: "Lipsesc câmpurile structurate.",
      }],
    },
  });
  assert.match(text, /Gemini a indicat că articolele sunt diferite/);
  assert.match(text, /verificarea automată a dovezilor nu a putut confirma verdictul/);
  assert.match(text, /different → uncertain \(0%\)/);
  assert.match(text, /validare: Lipsesc câmpurile structurate/);
});

test("model-supplied text cannot break the card or inject markup", () => {
  const text = formatApprovalText({
    kind: "article", url: "https://news.example/current",
    article: { title: "Articol nou" }, comparisonUrl: "https://news.example/old",
    comparisonTitle: "Articol anterior", similarity: 0,
    simResult: {
      similarityBasis: "semantic_ai", aiVerdict: "uncertain",
      aiRationale: "<b>urgent</b> & \"special\" {avertisment}",
      aiChecks: [{ model: "gemini-test", validatedVerdict: "uncertain", reason: "<script>alert(1)</script> motiv" }],
    },
  });
  assert.doesNotMatch(text, /<script>/);
  assert.doesNotMatch(text, /<b>urgent<\/b>/);
  assert.match(text, /urgent/);
  assert.match(text, /motiv/);
});

test("pending-approval duplicates are labeled as awaiting review and show attached sources", () => {
  const text = formatApprovalText({
    kind: "article", url: "https://news.example/current", article: { title: "Știrea curentă" },
    comparisonUrl: "https://news.example/pending", comparisonTitle: "Știre în așteptare", similarity: 0.91,
    simResult: { similarityBasis: "semantic_ai", aiVerdict: "duplicate", isPendingApproval: true },
    relatedArticles: [{ url: "https://news.example/other", article: { title: "Altă sursă" } }],
  });
  assert.match(text, /cerere deja în așteptare/);
  assert.match(text, /Linkuri suplimentare confirmate ca aceeași știre/);
  assert.match(text, /https:\/\/news\.example\/other/);
});

test("confirmed duplicate approval never says Gemini rejected the match", () => {
  const text = formatApprovalText({
    kind: "article", url: "https://news.example/current", article: { title: "Protestele elevilor din Franța" },
    comparisonUrl: "https://news.example/previous", comparisonTitle: "Bolojan despre alegeri anticipate",
    similarity: 0.97,
    simResult: { similarityBasis: "semantic_ai", aiVerdict: "duplicate", aiSimilarityProbability: 97 },
  });
  assert.match(text, /97% estimare Gemini/);
  assert.match(text, /Gemini .* a confirmat că relatează același fapt/);
  assert.doesNotMatch(text, /a decis că nu este același fapt|a respins potrivirea/);
});
