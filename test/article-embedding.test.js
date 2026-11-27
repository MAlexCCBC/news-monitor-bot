import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

import { checkSimilarity, checkSimilarityEmbedding, createArticleEmbedding, splitArticleContent } from "../src/similarity/embedding.js";

test("incompatible or invalid vectors cannot produce a false 100 percent duplicate", () => {
  const title = "Bolojan anunță reforma pensiilor";
  for (const embedding of [[1, 0, 100], [NaN, 0], [Infinity, 0], [0, 0]]) {
    const result = checkSimilarityEmbedding([1, 0], title, "", [{
      url: "https://example.com/invalid", title, content: "", embedding,
      embeddingModel: "gemini-embedding-001",
    }], .8, { embeddingModel: "gemini-embedding-001" });
    assert.equal(result.isDuplicate, false);
    assert.equal(result.similarUrl, null);
  }
});

test("restored and live comparisons use the same legacy primary-model compatibility", async () => {
  const title = "Bolojan anunță reforma pensiilor";
  const history = [{ url: "https://example.com/legacy", title, content: "", embedding: [1, 0] }];
  const restored = checkSimilarityEmbedding([1, 0], title, "", history, .8, { embeddingModel: "gemini-embedding-001" });
  assert.equal(restored.isDuplicate, true);
  const originalPost = axios.post;
  axios.post = async () => ({ data: { embeddings: [{ values: [1, 0] }] } });
  try {
    const live = await checkSimilarity(title, history);
    assert.equal(live.isDuplicate, restored.isDuplicate);
    assert.equal(live.similarUrl, restored.similarUrl);
  } finally { axios.post = originalPost; }
  assert.equal(checkSimilarityEmbedding([1, 0], title, "", history, .8,
    { embeddingModel: "gemini-embedding-2" }).isDuplicate, false);
});

test("article chunking covers the whole story instead of only its lead", () => {
  const article = "știre ".repeat(1200);
  const chunks = splitArticleContent(article, 1800);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.join("").replace(/\s/g, ""), article.replace(/\s/g, ""));
  assert.ok(chunks.every((chunk) => chunk.length <= 1800));
});

test("legacy duplicate vectors are reused without another API embedding call", async () => {
  const originalPost = axios.post;
  let payload;
  axios.post = async (_url, requestBody) => {
    payload = requestBody;
    return { data: { embeddings: requestBody.requests.map(() => ({ values: [1, 0] })) } };
  };
  const longBody = `${"Detalii despre reforma pensiilor anunțată de Bolojan. ".repeat(80)}MARCAJ_FINAL_ARTICOL`;
  try {
    const result = await checkSimilarity(
      `Bolojan anunță reforma pensiilor\n${longBody}`,
      [{
        url: "https://example.com/old",
        title: "Bolojan anunță reforma pensiilor",
        content: longBody,
        embedding: [1, 0],
        embeddingModel: "gemini-embedding-001",
        embeddingVersion: "legacy-title-lead-v0",
      }],
      0.8
    );
    assert.equal(payload.requests.length, splitArticleContent(longBody).length);
    assert.ok(payload.requests.some((request) => request.content.parts[0].text.includes("MARCAJ_FINAL_ARTICOL")));
    assert.equal(result.isDuplicate, true);
    assert.equal(result.similarity, 1);
    assert.equal(result.similarUrl, "https://example.com/old");
    assert.ok(result.similarityZone);
    assert.ok(result.similarityReason);
    assert.deepEqual(result.reembeddedNews, []);
  } finally {
    axios.post = originalPost;
  }
});

test("similarity embeds the incoming story once, not every historical article", async () => {
  const originalPost = axios.post;
  const calls = [];
  axios.post = async (url, requestBody) => {
    calls.push({ url, requestBody });
    return { data: { embeddings: requestBody.requests.map(() => ({ values: [1, 0] })) } };
  };

  const history = Array.from({ length: 250 }, (_, index) => ({
    url: `https://example.com/${index}`,
    title: `Articol istoric ${index}`,
    content: `Conținut istoric ${index}`,
    embedding: [0, 1],
    embeddingModel: "gemini-embedding-001",
    embeddingVersion: "article-full-v1:gemini-embedding-001",
  }));

  try {
    const result = await checkSimilarity("Știre nouă\nConținutul articolului nou", history, 0.8);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].requestBody.requests.length, 1);
    assert.equal(result.reembeddedNews.length, 0);
    assert.equal(result.embeddingModel, "gemini-embedding-001");
  } finally {
    axios.post = originalPost;
  }
});

test("AI similarity arbitration receives full candidate articles and can recover a local false negative", async () => {
  const originalPost = axios.post;
  const incomingBody = `Text integral nou despre evenimentul concret. ${"Finalul articolului nou. ".repeat(30)}MARCAJ_FINAL_NOU`;
  const previousBody = `Text integral anterior despre același eveniment. ${"Finalul articolului anterior. ".repeat(30)}MARCAJ_FINAL_ANTERIOR`;
  let reviewed;
  axios.post = async (_url, requestBody) => ({
    data: { embeddings: requestBody.requests.map(() => ({ values: requestBody.requests.length ? [1, 0] : [1, 0] })) },
  });
  try {
    const result = await checkSimilarity(
      `Titlu reformulat despre eveniment\n${incomingBody}`,
      [{
        url: "https://news.example/previous",
        title: "Relatarea anterioară a faptului",
        content: previousBody,
        embedding: [0.8, 0.6],
        embeddingModel: "gemini-embedding-001",
        embeddingVersion: "article-full-v1:gemini-embedding-001",
      }],
      0.8,
      "https://other.example/current",
      {
        arbitrate: async (incoming, candidates) => {
          reviewed = { incoming, candidates };
          return { model: "test-lite", results: [{ verdict: "duplicate", reason: "Aceeași dezvoltare" }] };
        },
      }
    );
    assert.match(reviewed.incoming.content, /MARCAJ_FINAL_NOU/);
    assert.match(reviewed.candidates[0].content, /MARCAJ_FINAL_ANTERIOR/);
    assert.equal(result.isDuplicate, true);
    assert.equal(result.similarityBasis, "semantic_ai");
    assert.equal(result.similarUrl, "https://news.example/previous");
    assert.match(result.similarityZone, /AI CONFIRMAT/);
  } finally {
    axios.post = originalPost;
  }
});

test("a verified publisher translation takes precedence over unrelated candidates", async (t) => {
  t.mock.method(axios, "post", async (_url, requestBody) => ({
    data: { embeddings: requestBody.requests.map(() => ({ values: [1, 0] })) },
  }));
  const english = [
    "The Ministry of Finance described the economic situation and public debt of 65 percent of GDP in the government report.",
    "The government proposes a budget review before August 2030. The Ministry of Finance will publish the updated fiscal report.",
    "The report notes that taxes collected for recycling household appliances will be transferred to the EU budget.",
  ].join("\n\n");
  const romanian = [
    "Ministerul Finanțelor a descris situația economică și datoria publică de 65 la sută din PIB în raportul Guvernului.",
    "Guvernul propune o revizuire a bugetului înainte de august 2030. Ministerul Finanțelor va publica raportul fiscal actualizat.",
    "Raportul notează că taxele colectate pentru reciclarea electrocasnicelor vor fi virate la bugetul UE.",
  ].join("\n\n");
  const incoming = "Ministry of Finance presents the economic situation and public debt\n" + english;
  const previous = {
    url: "https://news.example/economie/raport",
    title: "Ministerul Finanțelor prezintă situația economică și datoria publică",
    content: romanian,
    embedding: [0.94, Math.sqrt(1 - 0.94 ** 2)],
    embeddingModel: "gemini-embedding-001",
    embeddingVersion: "article-full-v1:gemini-embedding-001",
  };
  const result = await checkSimilarity(incoming, [previous], 0.8, "https://news.example/english/report", {
    arbitrate: async () => assert.fail("The translation already has matching body paragraphs"),
  });
  assert.equal(result.isDuplicate, true);
  assert.equal(result.similarUrl, previous.url);
  assert.equal(result.similarityBasis, "article_text");

  for (const alternate of [
    { ...previous, url: "https://other.example/economie/raport" },
    { ...previous, content: romanian.replace("65", "70") },
    { ...previous, content: romanian.split("\n\n")[0] },
  ]) {
    const contrast = await checkSimilarity(incoming, [alternate], 0.8, "https://news.example/english/report", {
      arbitrate: async () => ({ results: [{ verdict: "different" }] }),
    });
    assert.equal(contrast.isDuplicate, false);
  }
});

test("confirmed matches preserve pending-approval identity for duplicate-card suppression", async () => {
  const originalPost = axios.post;
  axios.post = async (_url, requestBody) => ({
    data: { embeddings: requestBody.requests.map(() => ({ values: [1, 0] })) },
  });
  try {
    const result = await checkSimilarity(
      "Guvernul Mureșan: vot de învestitură\nParlamentul votează Cabinetul propus de Siegfried Mureșan.",
      [{
        url: "https://news.example/pending",
        title: "Parlamentul votează Guvernul Mureșan",
        content: "Parlamentul votează Cabinetul propus de Siegfried Mureșan.",
        embedding: [1, 0],
        embeddingModel: "gemini-embedding-001",
        embeddingVersion: "article-full-v1:gemini-embedding-001",
        isPendingApproval: true,
        pendingApprovalId: "approval-42",
      }],
      .8,
      "https://other.example/current",
      { arbitrate: async () => ({ results: [{ verdict: "duplicate", reason: "Aceeași știre." }] }) },
    );
    assert.equal(result.isDuplicate, true);
    assert.equal(result.aiVerdict, "duplicate");
    assert.equal(result.isPendingApproval, true);
    assert.equal(result.pendingApprovalId, "approval-42");
  } finally {
    axios.post = originalPost;
  }
});

test("fallback embeddings reuse their own space and never re-embed the primary-model history", async () => {
  const originalPost = axios.post;
  const calls = [];
  axios.post = async (url, requestBody) => {
    calls.push({ url, requestBody });
    if (url.includes("gemini-embedding-001")) {
      const error = new Error("quota exhausted");
      error.response = { status: 429, data: { error: { message: "quota exhausted" } } };
      throw error;
    }
    return { data: { embeddings: requestBody.requests.map(() => ({ values: [1, 0] })) } };
  };

  const history = [
    {
      url: "https://example.com/primary",
      title: "Articol din spațiul primar",
      content: "Conținut vechi",
      embedding: [1, 0],
      embeddingModel: "gemini-embedding-001",
      embeddingVersion: "article-full-v1:gemini-embedding-001",
    },
    {
      url: "https://example.com/fallback",
      title: "Articol din spațiul fallback",
      content: "Conținut compatibil",
      embedding: [1, 0],
      embeddingModel: "gemini-embedding-2",
      embeddingVersion: "article-full-v1:gemini-embedding-2",
    },
  ];

  try {
    const result = await checkSimilarity("Titlu nou\nConținut nou", history, 0.8);
    const fallbackCalls = calls.filter((call) => call.url.includes("gemini-embedding-2"));

    assert.equal(result.embeddingModel, "gemini-embedding-2");
    assert.equal(result.reembeddedNews.length, 0);
    assert.equal(result.similarUrl, "https://example.com/fallback");
    assert.ok(fallbackCalls.every((call) => call.requestBody.requests.length === 1));
  } finally {
    axios.post = originalPost;
  }
});

test("article-body similarity considers history entries before headline anchoring", async () => {
  const originalPost = axios.post;
  axios.post = async (_url, requestBody) => ({
    data: { embeddings: requestBody.requests.map(() => ({ values: [1, 0] })) },
  });

  try {
    const result = await checkSimilarity(
      "Criza energetică de pe Nistru: măsuri noi\nRepublica Moldova declară stare de urgență energetică și hidrologică după problemele de pe Nistru. Maia Sandu a anunțat măsuri pentru protejarea sectorului energetic și a alimentării cu apă.",
      [{
        url: "https://example.com/previous",
        title: "Maia Sandu a convocat Consiliul de Securitate",
        content: "După problemele de pe Nistru, Republica Moldova declară stare de urgență în domeniul energetic și hidrologic. Maia Sandu a anunțat măsuri pentru protejarea sectorului energetic și a alimentării cu apă.",
        embedding: [1, 0],
        embeddingModel: "gemini-embedding-001",
        embeddingVersion: "article-full-v1:gemini-embedding-001",
      }],
      0.8
    );

    assert.equal(result.isDuplicate, true);
    assert.equal(result.similarUrl, "https://example.com/previous");
  } finally {
    axios.post = originalPost;
  }
});

test("full-article embeddings batch all chunks and aggregate their vectors", async () => {
  const originalPost = axios.post;
  let payload;
  axios.post = async (_url, requestBody) => {
    payload = requestBody;
    return {
      data: {
        embeddings: requestBody.requests.map((_request, index) => ({ values: [index + 1, index + 1] })),
      },
    };
  };

  try {
    const result = await createArticleEmbedding("Titlu test", "alineat ".repeat(700));
    assert.ok(payload.requests.length > 1);
    assert.ok(payload.requests.every((request) => request.content.parts[0].text.includes("Titlu: Titlu test")));
    const expectedAverage = (payload.requests.length + 1) / 2;
    assert.deepEqual(result.embedding, [expectedAverage, expectedAverage]);
    assert.equal(result.embeddingModel, "gemini-embedding-001");
    assert.match(result.embeddingVersion, /^article-full-v1:/);
  } finally {
    axios.post = originalPost;
  }
});
