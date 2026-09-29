import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

import { extractOpenAIRewriteText, isCompleteRewrite, rewriteArticle, validateRewriteGrounding } from "../src/ai/rewrite.js";

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

test("GPT-6 Luna writer uses Responses API with medium reasoning and logs returned usage", async () => {
  const originalPost = axios.post;
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-not-a-real-secret";
  const output = `📰 TITLU DE TEST\nContextul articolului.\n\n📌 Ideile principale:\n• 🔹 Primul punct complet.\n• 🔹 Al doilea punct complet.\n• 🔹 Al treilea punct complet.\nOficialul a declarat că situația continuă.\n💬 Ce părere aveți?\n\n👇 Așteptăm opinia ta în comentarii!`;
  let request;
  axios.post = async (url, body, config) => {
    request = { url, body, config };
    return { data: {
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: output }] }],
      usage: { input_tokens: 1200, output_tokens: 500, output_tokens_details: { reasoning_tokens: 120 } },
    } };
  };
  try {
    const result = await rewriteArticle("Articol sursă complet.");
    assert.equal(result.modelUsed, "gpt-6-luna");
    assert.equal(result.text, output);
    assert.equal(request.url, "https://api.openai.com/v1/responses");
    assert.equal(request.body.model, "gpt-6-luna");
    assert.equal(request.body.reasoning.effort, "medium");
    assert.equal(request.config.headers.Authorization, "Bearer test-key-not-a-real-secret");
  } finally {
    axios.post = originalPost;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

test("OpenAI Responses output extraction ignores reasoning and preserves only final text", () => {
  assert.equal(extractOpenAIRewriteText({ output: [
    { type: "reasoning", summary: "internal" },
    { type: "message", content: [{ type: "output_text", text: "Final ", annotations: [] }, { type: "output_text", text: "answer" }] },
  ] }), "Final answer");
});
