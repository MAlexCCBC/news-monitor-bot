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
  assert.match(text, /href="https:\/\/news\.example\/current\?id=1&amp;x=2"/);
  assert.match(text, /href="https:\/\/news\.example\/previous"/);
  assert.match(text, /expiră în 12 ore/);
});

test("AI similarity prompt clearly compares against an AI-created story and has no expiry", () => {
  const text = formatApprovalText({
    kind: "ai_text",
    article: { title: "Articol curent" },
    url: "https://news.example/current",
    comparisonTitle: "Text AI anterior",
    comparisonUrl: "https://news.example/previous",
    similarity: 0.88,
    formattedPost: "Previzualizare text",
  });

  assert.match(text, /Comparație cu știri create deja cu AI/);
  assert.match(text, /Știre creată anterior cu AI/);
  assert.match(text, /href="https:\/\/news\.example\/previous"/);
  assert.match(text, /Cererea nu expiră/);
});
