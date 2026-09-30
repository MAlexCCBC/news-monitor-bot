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
  assert.match(text, /Scorul semantic este apropierea vectorilor/);
  assert.match(text, /nu probabilitate/);
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
  assert.match(text, /Similaritate neclară — verificare manuală/);
  assert.match(text, /96% estimare Gemini/);
  assert.match(text, /a sugerat „same_report"/);
  assert.match(text, /nu este o probabilitate statistică calibrată/);
  assert.match(text, /Explicația Gemini: Ambele redau aceeași declarație/);
  assert.match(text, /Verificări păstrate: gemini-test: uncertain \(96%\)/);
  assert.doesNotMatch(text, /scor semantic 0%/);
});

test("pending-approval duplicates are labeled as awaiting review and show attached sources", () => {
  const text = formatApprovalText({
    kind: "article", url: "https://news.example/current", article: { title: "Știrea curentă" },
    comparisonUrl: "https://news.example/pending", comparisonTitle: "Știre în așteptare", similarity: 0.91,
    simResult: { similarityBasis: "semantic_ai", aiVerdict: "duplicate", isPendingApproval: true },
    relatedArticles: [{ url: "https://news.example/other", article: { title: "Altă sursă" } }],
  });
  assert.match(text, /aprobare deja în așteptare/);
  assert.match(text, /Linkuri suplimentare confirmate ca aceeași știre/);
  assert.match(text, /https:\/\/news\.example\/other/);
});
