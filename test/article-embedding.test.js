import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

import { checkSimilarity, createArticleEmbedding, splitArticleContent } from "../src/similarity/embedding.js";

test("article chunking covers the whole story instead of only its lead", () => {
  const article = "știre ".repeat(1200);
  const chunks = splitArticleContent(article, 1800);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.join("").replace(/\s/g, ""), article.replace(/\s/g, ""));
  assert.ok(chunks.every((chunk) => chunk.length <= 1800));
});

test("legacy duplicate candidates are re-embedded from their complete stored article", async () => {
  const originalPost = axios.post;
  let payload;
  axios.post = async (_url, requestBody) => {
    payload = requestBody;
    return { data: { embeddings: requestBody.requests.map(() => ({ values: [1, 0] })) } };
  };
  const longBody = `${"Detalii despre reforma pensiilor anunțată de Bolojan. ".repeat(80)}MARCAJ_FINAL_ARTICOL`;
  const reembedded = [];

  try {
    const result = await checkSimilarity(
      `Bolojan anunță reforma pensiilor\n${longBody}`,
      [{ url: "https://example.com/old", title: "Bolojan anunță reforma pensiilor", content: longBody, embedding: [1, 0] }],
      0.8,
      { onReembed: (item) => reembedded.push(item) }
    );
    assert.ok(payload.requests.some((request) => request.content.parts[0].text.includes("MARCAJ_FINAL_ARTICOL")));
    assert.equal(reembedded.length, 1);
    assert.equal(reembedded[0].embeddingVersion, "article-full-v1:gemini-embedding-001");
    assert.equal(result.isDuplicate, true);
    assert.equal(result.similarity, 1);
    assert.equal(result.similarUrl, "https://example.com/old");
    assert.ok(result.similarityZone);
    assert.ok(result.similarityReason);
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
