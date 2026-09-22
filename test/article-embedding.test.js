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
