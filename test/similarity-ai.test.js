import test from "node:test";
import assert from "node:assert/strict";

import { arbitrateSimilarity, parseSimilarityReview } from "../src/similarity/ai-arbitrator.js";
import { applySimilarityAiReview } from "../src/similarity/embedding.js";

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
        return { data: { candidates: [{ content: { parts: [{ text: calls === 1 ? "not json" : JSON.stringify({ results: [{
          id: 1,
          verdict: "different",
          reason: "Articolele descriu fapte diferite.",
          incoming_fact: { actor: "corpul nou", action: "este integral", object: "paragraful nou", stage: "final nou" },
          candidate_fact: { actor: "corpul vechi", action: "este integral", object: "paragraful vechi", stage: "final vechi" },
          incoming_evidence_ids: ["E2"],
          candidate_evidence_ids: ["E2"],
        }] }) }] } }] } };
      },
    }
  );
  assert.equal(calls, 2);
  assert.match(prompts[0], /Corpul integral nou, inclusiv paragraful de final/);
  assert.match(prompts[0], /Corpul integral vechi, inclusiv paragraful de final/);
  assert.match(prompts[0], /Aceeași conferință de presă, ședință, vizită sau comunicat NU este suficientă/);
  assert.match(prompts[0], /identifică mai întâi în minte faptul central/);
  assert.match(prompts[0], /Motivul trebuie să numească pe scurt faptul comun concret/);
  assert.deepEqual(result.results, [{ verdict: "different", reason: "Articolele descriu fapte diferite." }]);
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
                parts: [{ text: JSON.stringify({ results: [{
                  id: 1,
                  verdict: "different",
                  reason: "Primul anunță agenda, al doilea relatează întâlnirea și discuțiile desfășurate.",
                  incoming_fact: { actor: "Nicușor Dan", action: "relatează întâlnire", object: "securitatea regională", stage: "întâlnire desfășurată" },
                  candidate_fact: { actor: "Nicușor Dan", action: "anunță agendă", object: "întâlnire cu președintele ceh", stage: "plan înaintea întâlnirii" },
                  incoming_evidence_ids: ["E2"],
                  candidate_evidence_ids: ["E2"],
                }] }) }],
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

test("a generic duplicate verdict about the post-vote context is downgraded when event facts differ", () => {
  const incoming = {
    title: "Nicușor Dan anunță că luni va nominaliza un nou nume de prim-ministru, după consultări cu partidele",
    content: "Președintele Nicușor Dan a anunțat că va avea luni dimineață consultări la Cotroceni și luni după-amiază va nominaliza o propunere de premier.",
  };
  const candidate = {
    title: "Siegfried Mureșan: Așteptăm să vedem din partea președintelui României care sunt următorii pași / Radu Miruță: Nu vom lăsa ca PSD să se urce iarăși cu picioarele pe finanțele României",
    content: "Siegfried Mureșan a declarat miercuri, după votul din Parlament, că PNL așteaptă să vadă din partea președintelui Nicușor Dan care sunt pașii următori. Radu Miruță a declarat că USR va continua colaborarea cu PNL.",
  };
  const result = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "duplicate",
    reason: "Aceleași declarații oficiale imediate după vot.",
    incoming_fact: { actor: "Nicușor Dan", action: "anunță consultări și desemnare", object: "va consulta partidele și va nominaliza luni un premier", stage: "plan viitor" },
    candidate_fact: { actor: "Siegfried Mureșan", action: "așteaptă pași", object: "pașii următori ai președintelui", stage: "reacție după vot" },
    incoming_evidence_ids: ["E2"],
    candidate_evidence_ids: ["E2"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result[0].verdict, "uncertain");
  assert.match(result[0].reason, /Acțiunile centrale extrase diferă/);
});

test("a positive full-text duplicate requires exact evidence and matching event facts", () => {
  const incoming = {
    title: "Dan Motreanu: anticipatele pot schimba realitatea politică",
    content: "Secretarul general al PNL, Dan Motreanu, a spus că alegerile anticipate pot schimba realitatea politică.",
  };
  const candidate = {
    title: "Motreanu afirmă că alegerile anticipate pot schimba scena politică",
    content: "Dan Motreanu, secretarul general al PNL, a declarat că alegerile anticipate pot schimba realitatea politică.",
  };
  const result = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "same_report",
    reason: "Aceeași declarație a lui Dan Motreanu despre efectul anticipatelor.",
    incoming_fact: { actor: "Dan Motreanu", action: "afirmă schimbarea realității politice", object: "alegerile anticipate", stage: "declarație despre anticipate" },
    candidate_fact: { actor: "Dan Motreanu", action: "afirmă schimbarea realității politice", object: "alegerile anticipate", stage: "declarație despre anticipate" },
    incoming_evidence_ids: ["E2"],
    candidate_evidence_ids: ["E2"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result[0].verdict, "duplicate");
});

test("duplicate evidence with invented paragraph IDs becomes uncertain", () => {
  const incoming = { title: "Anunțul oficial despre o decizie nouă", content: "Autoritățile au anunțat o decizie nouă privind proiectul." };
  const candidate = { title: "Autoritățile anunță decizia", content: "A fost prezentată o hotărâre diferită." };
  const result = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "duplicate",
    reason: "Aceeași decizie.",
    incoming_fact: { actor: "Autoritățile", action: "anunță decizia", object: "decizia nouă", stage: "anunț" },
    candidate_fact: { actor: "Autoritățile", action: "anunță decizia", object: "decizia nouă", stage: "anunț" },
    incoming_evidence_ids: ["E9"],
    candidate_evidence_ids: ["E9"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result[0].verdict, "uncertain");
  assert.match(result[0].reason, /unități valide/);
});

test("valid paragraph references preserve a duplicate when Gemini paraphrases its evidence in the output", () => {
  const incoming = {
    title: "Nicușor Dan anunță consultări și un nou premier luni",
    content: "Luni voi convoca partidele la Cotroceni pentru consultări, iar luni după-amiaza voi nominaliza o propunere de prim-ministru.",
  };
  const candidate = {
    title: "BREAKING: Nicușor Dan va nominaliza luni un nou premier",
    content: "Luni voi convoca partidele la Cotroceni pentru consultări, iar luni după-amiază voi nominaliza o propunere de premier.",
  };
  const result = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "same_report",
    reason: "Aceeași declarație despre consultări și nominalizarea de luni.",
    incoming_fact: { actor: "Nicușor Dan", action: "anunță desemnare", object: "prim-ministru", stage: "luni după consultări" },
    candidate_fact: { actor: "Nicușor Dan", action: "anunță desemnare", object: "prim-ministru", stage: "luni după consultări" },
    incoming_evidence_ids: ["E2"],
    candidate_evidence_ids: ["E2"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result[0].verdict, "duplicate");
});

test("a negative verdict without traceable evidence becomes uncertain instead of silently missing a duplicate", () => {
  const incoming = { title: "Anunțul despre proiectul X", content: "Primarul a anunțat astăzi că proiectul X va începe luni, după aprobarea bugetului." };
  const candidate = { title: "Primarul anunță începerea proiectului X", content: "Proiectul X începe luni după ce bugetul a fost aprobat, a spus primarul." };
  const result = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "different",
    reason: "Formulările sunt diferite.",
  }] }), 1, incoming, [candidate]);
  assert.equal(result[0].verdict, "uncertain");
  assert.match(result[0].reason, /Lipsește fișa faptului central/);
});

test("a duplicate verdict cannot pass on a short object that is only a subset of a different concrete object", () => {
  const incoming = {
    title: "Guvernul anunță reducerea TVA la alimente",
    content: "Guvernul României a anunțat reducerea TVA pentru alimente în proiectul fiscal discutat astăzi.",
  };
  const candidate = {
    title: "Guvernul anunță reducerea TVA la combustibil",
    content: "Guvernul României a anunțat reducerea TVA pentru combustibil în proiectul fiscal discutat astăzi.",
  };
  const result = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "same_report",
    reason: "Aceeași reducere a TVA.",
    incoming_fact: { actor: "Guvernul României", action: "anunță reducerea", object: "TVA", stage: "proiect fiscal" },
    candidate_fact: { actor: "Guvernul României", action: "anunță reducerea", object: "TVA la combustibil", stage: "proiect fiscal" },
    incoming_evidence_ids: ["E2"],
    candidate_evidence_ids: ["E2"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result[0].verdict, "uncertain");
});

test("paragraph evidence references reject duplicate IDs, title-only support, and out-of-range units", () => {
  const incoming = { title: "Nicușor Dan anunță consultări", content: "Președintele Nicușor Dan va consulta partidele luni, apoi va nominaliza un premier." };
  const candidate = { title: "Nicușor Dan anunță consultări", content: "Președintele Nicușor Dan va consulta partidele luni, apoi va nominaliza un premier." };
  const base = {
    id: 1,
    verdict: "duplicate",
    reason: "Aceeași declarație.",
    incoming_fact: { actor: "Nicușor Dan", action: "anunță consultări", object: "partidele și premierul", stage: "luni" },
    candidate_fact: { actor: "Nicușor Dan", action: "anunță consultări", object: "partidele și premierul", stage: "luni" },
  };
  for (const [incomingIds, candidateIds] of [[ ["E2", "E2"], ["E2"] ], [["E3"], ["E2"]], [["E1"], ["E1"]]]) {
    const result = parseSimilarityReview(JSON.stringify({ results: [{ ...base, incoming_evidence_ids: incomingIds, candidate_evidence_ids: candidateIds }] }), 1, incoming, [candidate]);
    assert.equal(result[0].verdict, "uncertain");
  }
});

test("metamorphic object-substitution cases cannot turn a shared policy label into a confirmed duplicate", () => {
  const distinctObjects = [
    ["alimente", "combustibil"], ["pensii", "salarii"], ["școli", "spitale"],
    ["transport", "energie"], ["agricultură", "industrie"], ["locuințe", "medicamente"],
    ["exporturi", "importuri"], ["impozite", "contribuții"], ["autostrăzi", "căi ferate"],
    ["refugiați", "fermieri"], ["buget", "datorie"], ["subvenții", "amenzi"],
    ["curent", "gaze"], ["TVA", "accize"], ["profesori", "medici"],
    ["granturi", "credite"], ["alegeri", "referendum"], ["frontieră", "port"],
    ["firme", "gospodării"], ["apărare", "sănătate"],
  ];
  for (const [left, right] of distinctObjects) {
    const incoming = {
      title: `Guvernul anunță măsura privind ${left}`,
      content: `Guvernul României a anunțat o măsură nouă privind ${left}. Proiectul va intra în vigoare după publicarea deciziei oficiale.`,
    };
    const candidate = {
      title: `Guvernul anunță măsura privind ${right}`,
      content: `Guvernul României a anunțat o măsură nouă privind ${right}. Proiectul va intra în vigoare după publicarea deciziei oficiale.`,
    };
    const result = parseSimilarityReview(JSON.stringify({ results: [{
      id: 1,
      verdict: "same_report",
      reason: "Același anunț al Guvernului.",
      incoming_fact: { actor: "Guvernul României", action: "anunță măsura", object: `măsura ${left}`, stage: "proiect anunțat" },
      candidate_fact: { actor: "Guvernul României", action: "anunță măsura", object: `măsura ${right}`, stage: "proiect anunțat" },
      incoming_evidence_ids: ["E2"],
      candidate_evidence_ids: ["E2"],
    }] }), 1, incoming, [candidate]);
    assert.equal(result[0].verdict, "uncertain", `${left} vs ${right}`);
  }
});

test("an unsupported Gemini duplicate reaches manual review instead of blocking or silently passing", () => {
  const incoming = {
    title: "Nicușor Dan anunță consultări și nominalizarea unui premier luni",
    content: "Președintele Nicușor Dan a spus că va consulta partidele luni și va desemna un premier în aceeași zi.",
  };
  const candidate = {
    title: "Siegfried Mureșan așteaptă pașii următori după votul din Parlament",
    content: "Siegfried Mureșan a declarat după vot că așteaptă să vadă care sunt pașii următori ai președintelui.",
  };
  const parsed = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "same_report",
    reason: "Aceeași criză politică după vot.",
    incoming_fact: { actor: "Nicușor Dan", action: "anunță consultări și desemnare", object: "un premier luni", stage: "plan după vot" },
    candidate_fact: { actor: "Siegfried Mureșan", action: "așteaptă pașii următori", object: "decizia președintelui", stage: "reacție după vot" },
    incoming_evidence_ids: ["E2"],
    candidate_evidence_ids: ["E2"],
  }] }), 1, incoming, [candidate]);
  const localCandidate = {
    url: "https://news.example/older",
    score: .91,
    isDuplicate: true,
    embeddingComparable: true,
  };
  const final = applySimilarityAiReview([localCandidate], [localCandidate], { results: parsed });
  assert.equal(parsed[0].verdict, "uncertain");
  assert.equal(final.isDuplicate, true);
  assert.equal(final.aiVerdict, "uncertain");
  assert.match(final.similarityZone, /NECESITĂ VERIFICARE/);
});
