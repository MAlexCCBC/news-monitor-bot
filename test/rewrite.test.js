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

test("Romanian comma-below at the end of a person's name is not truncated as an ASCII word boundary", () => {
  const source = "Andrea Chiș, fosta judecătoare propusă pentru funcția de ministru al Justiției, a spus că pensia sa este de 40.000 de lei.";
  const output = "⚖️ ANDREA CHIȘ A VORBIT DESPRE PENSIA DE SERVICIU\nAndrea Chiș a spus că pensia sa este de 40.000 de lei.";
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

test("any non-empty GPT draft is returned without Gemini fallbacks even when checks reject it", async () => {
  const originalPost = axios.post;
  const originalGet = axios.get;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const events = [];
  let geminiCalls = 0;
  process.env.OPENAI_API_KEY = "test-key-not-a-real-secret";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  console.log = (message) => events.push(String(message));
  console.warn = (message) => events.push(String(message));
  axios.get = async () => {
    throw new Error("Gemini model discovery must not run after GPT returns text");
  };
  axios.post = async (url) => url.includes("api.openai.com")
    ? { data: {
        status: "completed",
        output_text: completePost.replace("Contextul articolului.", "Siegfried Mureșan a anunțat o decizie nouă."),
        usage: { input_tokens: 1707, output_tokens: 1007, output_tokens_details: { reasoning_tokens: 0 } },
      } }
    : (geminiCalls++, { data: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: completePost }] } }] } });
  try {
    const result = await rewriteArticle("Articol sursă complet.");
    assert.equal(result.modelUsed, "gpt-6-luna");
    assert.match(result.text, /Siegfried Mureșan/);
    assert.equal(geminiCalls, 0);
    const usageIndex = events.findIndex((line) => line.includes("usage: input=1707, output=1007"));
    const diagnosticIndex = events.findIndex((line) => line.includes("a generat text; îl trimit fără fallback Gemini"));
    assert.ok(usageIndex >= 0);
    assert.ok(diagnosticIndex > usageIndex, "usage is logged before non-blocking diagnostics");
  } finally {
    axios.post = originalPost;
    axios.get = originalGet;
    console.log = originalLog;
    console.warn = originalWarn;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
  }
});

test("non-empty GPT text is delivered without fallback even when the API marks it incomplete", async () => {
  const originalPost = axios.post;
  const originalGet = axios.get;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalLog = console.log;
  const originalWarn = console.warn;
  process.env.OPENAI_API_KEY = "test-key-not-a-real-secret";
  console.log = () => {};
  console.warn = () => {};
  axios.get = async () => {
    throw new Error("Gemini model discovery must not run after GPT returns text");
  };
  axios.post = async (url) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    return { data: { status: "incomplete", output_text: "Titlu și context parțial." } };
  };
  try {
    const result = await rewriteArticle("Articol sursă complet.");
    assert.equal(result.modelUsed, "gpt-6-luna");
    assert.equal(result.text, "Titlu și context parțial.");
  } finally {
    axios.post = originalPost;
    axios.get = originalGet;
    console.log = originalLog;
    console.warn = originalWarn;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
});

test("OpenAI Responses output extraction ignores reasoning and preserves only final text", () => {
  assert.equal(extractOpenAIRewriteText({ output: [
    { type: "reasoning", summary: "internal" },
    { type: "message", content: [{ type: "output_text", text: "Final ", annotations: [] }, { type: "output_text", text: "answer" }] },
  ] }), "Final answer");
});
