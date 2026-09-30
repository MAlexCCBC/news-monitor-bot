import test from "node:test";
import assert from "node:assert/strict";

import { arbitrateSimilarity, parseSimilarityReview } from "../src/similarity/ai-arbitrator.js";

test("similarity review parser requires one valid decision per candidate", () => {
  assert.deepEqual(parseSimilarityReview('{"results":[{"id":1,"verdict":"different","reason":"Alt eveniment"},{"id":2,"verdict":"duplicate","reason":"Aceeași relatare"}]}', 2), [
    { verdict: "different", reason: "Alt eveniment" },
    { verdict: "duplicate", reason: "Aceeași relatare" },
  ]);
  assert.throws(() => parseSimilarityReview('{"results":[{"id":1,"verdict":"duplicate"}]}', 2), /a omis candidați/);
  assert.throws(() => parseSimilarityReview('{"results":[{"id":1,"verdict":"yes"}]}', 1), /verdict/);
});

test("similarity arbitration compares full article text and falls through malformed model output", async () => {
  const prompts = [];
  let calls = 0;
  const result = await arbitrateSimilarity(
    { title: "Articol nou", content: "Corpul integral nou, inclusiv paragraful de final." },
    [{ title: "Articol vechi", content: "Corpul integral vechi, inclusiv paragraful de final." }],
    {
      models: ["lite-a", "lite-b"],
      modelFilter: async (models) => models,
      callModel: async (_model, prompt) => {
        prompts.push(prompt);
        calls++;
        return { data: { candidates: [{ content: { parts: [{ text: calls === 1 ? "not json" : '{"results":[{"id":1,"verdict":"different","reason":"Fapte diferite"}]}' }] } }] } };
      },
    }
  );
  assert.equal(calls, 2);
  assert.match(prompts[0], /Corpul integral nou, inclusiv paragraful de final/);
  assert.match(prompts[0], /Corpul integral vechi, inclusiv paragraful de final/);
  assert.match(prompts[0], /Aceeași conferință de presă, ședință, vizită sau comunicat NU este suficientă/);
  assert.match(prompts[0], /identifică mai întâi în minte faptul central/);
  assert.match(prompts[0], /Motivul trebuie să numească pe scurt faptul comun concret/);
  assert.deepEqual(result.results, [{ verdict: "different", reason: "Fapte diferite" }]);
});

test("similarity arbitration assigns explicit candidate IDs and distinguishes a visit announcement from its later outcome", async () => {
  let capturedPrompt = "";
  const result = await arbitrateSimilarity(
    { title: "Dan s-a întâlnit cu președintele ceh", content: "Întâlnirea a avut loc astăzi, iar cei doi au discutat securitatea regională." },
    [{ title: "Dan pleacă mâine în Cehia", content: "Agenda anunțată include o întâlnire cu președintele ceh." }],
    {
      models: ["test-model"],
      modelFilter: async (models) => models,
      callModel: async (_model, prompt) => {
        capturedPrompt = prompt;
        return {
          data: {
            candidates: [{
              content: {
                parts: [{ text: '{"results":[{"id":1,"verdict":"different","reason":"Primul anunță agenda, al doilea relatează întâlnirea desfășurată și discuțiile."}]}' }],
              },
            }],
          },
        };
      },
    }
  );
  assert.match(capturedPrompt, /CANDIDAT ID 1/);
  assert.match(capturedPrompt, /faptul central/);
  assert.equal(result.results[0].verdict, "different");
});
