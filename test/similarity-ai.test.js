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
  assert.match(prompts[0], /valorile concrete centrale/);
  assert.match(prompts[0], /Motivul trebuie să numească pe scurt faptul comun concret/);
  assert.match(prompts[0], /"incoming_evidence_ids":\["E2"\],"candidate_evidence_ids":\["E2"\]/);
  assert.doesNotMatch(prompts[0], /"incoming_evidence_ids":\["E1"\]/);
  assert.match(prompts[0], /E1 este doar titlul, niciodată dovadă/);
  assert.match(prompts[0], /duplicate_probability/);
  assert.deepEqual(result.results, [{ verdict: "different", reason: "Articolele descriu fapte diferite." }]);
});

test("invalid evidence references trigger one Gemini fallback and preserve the best abstention if needed", async () => {
  const incoming = { title: "Guvernul publică proiectul de reducere TVA", content: "Guvernul a publicat proiectul pentru reducerea TVA la alimente în aprilie." };
  const candidate = { title: "Proiectul Guvernului reduce TVA la alimente", content: "Guvernul a publicat proiectul pentru reducerea TVA la alimente în aprilie." };
  let calls = 0;
  const prompts = [];
  const result = await arbitrateSimilarity(incoming, [candidate], {
    models: ["gemini-citation-a", "gemini-citation-b"],
    modelFilter: async (models) => models,
    callModel: async (_model, prompt) => {
      calls++;
      prompts.push(prompt);
      const invalid = calls === 1;
      return { data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ results: [{
        id: 1,
        verdict: "same_report",
        reason: "Ambele articole descriu același proiect de reducere TVA.",
        incoming_fact: { actor: "Guvernul", action: "publică proiectul", object: "reducerea TVA la alimente", stage: "proiect publicat în aprilie" },
        candidate_fact: { actor: "Guvernul", action: "publică proiectul", object: "reducerea TVA la alimente", stage: "proiect publicat în aprilie" },
        incoming_evidence_ids: ["E2"],
        candidate_evidence_ids: [invalid ? "E99" : "E2"],
      }] }) }] } }] } };
    },
  });
  assert.equal(calls, 2);
  assert.doesNotMatch(prompts[0], /REVERIFICARE STRICTĂ A REFERINȚELOR/);
  assert.match(prompts[1], /REVERIFICARE STRICTĂ A REFERINȚELOR/);
  assert.match(prompts[1], /citează cel puțin un paragraf de corp \(E2 sau mai mare\)/);
  assert.equal(result.model, "gemini-citation-b");
  assert.equal(result.results[0].verdict, "duplicate");
});

test("evidence fallback retries only the candidates whose citations failed and preserves other decisions", async () => {
  const incoming = {
    title: "Guvernul anunță reducerea TVA la alimente",
    content: "Guvernul României anunță reducerea taxei pe valoarea adăugată pentru alimente, printr-un proiect publicat luni.",
  };
  const duplicate = {
    title: "Proiectul Guvernului reduce taxa pe alimente",
    content: "Guvernul României anunță reducerea taxei pe valoarea adăugată pentru alimente, printr-un proiect publicat luni.",
  };
  const distinct = {
    title: "Guvernul anunță majorarea accizelor la combustibil",
    content: "Guvernul României anunță majorarea accizelor aplicate combustibilului, printr-un proiect publicat luni.",
  };
  const prompts = [];
  let calls = 0;
  const same = {
    id: 1,
    verdict: "same_report",
    reason: "Ambele articole relatează același proiect de reducere a TVA la alimente.",
    incoming_fact: { actor: "Guvernul României", action: "anunță reducerea taxei", object: "taxa pe valoarea adăugată pentru alimente", stage: "proiect publicat luni" },
    candidate_fact: { actor: "Guvernul României", action: "anunță reducerea taxei", object: "taxa pe valoarea adăugată pentru alimente", stage: "proiect publicat luni" },
    incoming_evidence_ids: ["E2"],
    candidate_evidence_ids: ["E2"],
  };
  const result = await arbitrateSimilarity(incoming, [duplicate, distinct], {
    models: ["gemini-focus-a", "gemini-focus-b"],
    modelFilter: async (models) => models,
    callModel: async (_model, prompt) => {
      prompts.push(prompt);
      calls++;
      const results = calls === 1
        ? [
          { ...same, incoming_evidence_ids: ["E1"], candidate_evidence_ids: ["E1"] },
          {
            id: 2,
            verdict: "different",
            reason: "Primul articol descrie TVA la alimente, al doilea accize la combustibil.",
            incoming_fact: { actor: "Guvernul României", action: "anunță reducerea", object: "taxa pe valoarea adăugată pentru alimente", stage: "proiect publicat luni" },
            candidate_fact: { actor: "Guvernul României", action: "anunță majorarea", object: "accize aplicate combustibilului", stage: "proiect publicat luni" },
            incoming_evidence_ids: ["E2"],
            candidate_evidence_ids: ["E2"],
          },
        ]
        : [same];
      return { data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ results }) }] } }] } };
    },
  });
  assert.equal(calls, 2);
  assert.match(prompts[1], /REVERIFICARE STRICTĂ A REFERINȚELOR/);
  assert.match(prompts[1], /CANDIDAT ID 1/);
  assert.doesNotMatch(prompts[1], /majorarea accizelor la combustibil/);
  assert.deepEqual(result.results.map(({ verdict }) => verdict), ["duplicate", "different"]);
});

test("similarity arbitration routes an unsupported visit-stage distinction to manual review", async () => {
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
  assert.equal(result.results[0].verdict, "uncertain");
  assert.match(result.results[0].reason, /verificare manuală/);
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
    duplicate_probability: 94,
    reason: "Aceleași declarații oficiale imediate după vot.",
    incoming_fact: { actor: "Nicușor Dan", action: "anunță consultări și desemnare", object: "va consulta partidele și va nominaliza luni un premier", stage: "plan viitor" },
    candidate_fact: { actor: "Siegfried Mureșan", action: "așteaptă pași", object: "pașii următori ai președintelui", stage: "reacție după vot" },
    incoming_evidence_ids: ["E2"],
    candidate_evidence_ids: ["E2"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result[0].verdict, "uncertain");
  assert.equal(result[0].modelVerdict, "duplicate");
  assert.equal(result[0].duplicateProbability, 94);
  assert.match(result[0].reason, /Acțiunile centrale extrase diferă/);
});

test("a distinct stage with evidence in both article bodies can be automatically rejected", () => {
  const incoming = {
    title: "Nicușor Dan anunță consultări și desemnarea unui premier luni",
    content: "Președintele Nicușor Dan a anunțat consultări cu partidele luni dimineață și nominalizarea unui premier în aceeași zi.",
  };
  const candidate = {
    title: "Siegfried Mureșan așteaptă pașii următori după vot",
    content: "După votul din Parlament, Siegfried Mureșan a declarat că PNL așteaptă să vadă care sunt pașii următori ai președintelui.",
  };
  const result = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "different",
    reason: "Unul este anunțul calendarului prezidențial, celălalt este reacția ulterioară a lui Mureșan.",
    incoming_fact: { actor: "Nicușor Dan", action: "anunță consultări", object: "partidele și premierul", stage: "calendarul de luni" },
    candidate_fact: { actor: "Siegfried Mureșan", action: "așteaptă pașii următori", object: "decizia președintelui", stage: "reacție după vot" },
    incoming_evidence_ids: ["E2"],
    candidate_evidence_ids: ["E2"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result[0].verdict, "different", result[0].reason);
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
  assert.equal(result[0].verdict, "duplicate", result[0].reason);
});

test("conflicting central vote estimates are sent to manual review, not auto-merged", () => {
  const incoming = {
    title: "Kelemen Hunor estimează 229 de voturi teoretice pentru Guvernul Mureșan",
    content: "Înainte de vot, Kelemen Hunor a estimat 229 de voturi teoretice pentru Guvernul Mureșan, sub pragul de 233 de voturi necesare.",
  };
  const candidate = {
    title: "Kelemen Hunor nu vede voturile pentru Guvernul Mureșan",
    content: "Înainte de vot, Kelemen Hunor a spus la RFI că nu vede acele voturi dincolo de 170, 171 pentru Guvernul Mureșan; pragul rămâne 233.",
  };
  const result = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "same_report",
    reason: "Kelemen Hunor vorbește în ambele articole despre șansele Guvernului Mureșan la vot.",
    incoming_fact: { actor: "Kelemen Hunor", action: "estimează voturile", object: "voturile Guvernului Mureșan", stage: "înainte de vot" },
    candidate_fact: { actor: "Kelemen Hunor", action: "estimează voturile", object: "voturile Guvernului Mureșan", stage: "înainte de vot" },
    incoming_evidence_ids: ["E2"],
    candidate_evidence_ids: ["E2"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result[0].verdict, "uncertain");
  assert.match(result[0].reason, /Estimările numerice privind numărul de voturi diferă/);
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

test("traceable same-event evidence survives substantial outlet paraphrasing when event facts match", () => {
  const incoming = {
    title: "Guvernul reduce TVA pentru alimente după aprobarea proiectului fiscal",
    content: "Executivul a prezentat un proiect care micșorează taxa pe valoarea adăugată pentru produsele alimentare. Măsura se va aplica după adoptarea actului normativ.",
  };
  const candidate = {
    title: "Proiectul fiscal prevede o cotă TVA mai mică la produsele alimentare",
    content: "Documentul publicat de Guvern prevede scăderea TVA pentru alimente. Aplicarea modificării este stabilită după intrarea în vigoare a actului normativ.",
  };
  const result = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "same_report",
    reason: "Ambele texte descriu aceeași reducere a TVA la alimente prevăzută în proiectul Guvernului.",
    incoming_fact: { actor: "Guvernul României", action: "prezintă un proiect de reducere TVA", object: "TVA pentru alimente", stage: "măsură prevăzută în proiect" },
    candidate_fact: { actor: "Guvernul României", action: "prezintă un proiect de reducere TVA", object: "TVA pentru alimente", stage: "măsură prevăzută în proiect" },
    incoming_evidence_ids: ["E1", "E2"],
    candidate_evidence_ids: ["E1", "E2"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result[0].verdict, "duplicate", result[0].reason);
});

test("safe Romanian concept aliases preserve a duplicate without treating a shared tax label as enough", () => {
  const incoming = {
    title: "Guvernul reduce TVA la alimente",
    content: "Guvernul a publicat proiectul care reduce TVA pentru alimente.",
  };
  const candidate = {
    title: "Guvernul reduce taxa pe valoarea adăugată pentru produse alimentare",
    content: "Executivul a prezentat proiectul privind reducerea taxei pe valoarea adăugată la produse alimentare.",
  };
  const result = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "same_report",
    reason: "Aceeași reducere a taxei pe valoarea adăugată pentru alimente.",
    incoming_fact: { actor: "Guvernul României", action: "reduce taxa", object: "TVA pentru alimente", stage: "proiect fiscal" },
    candidate_fact: { actor: "Guvernul României", action: "reduce taxa", object: "taxa pe valoarea adăugată pentru produse alimentare", stage: "proiect fiscal" },
    incoming_evidence_ids: ["E1", "E2"],
    candidate_evidence_ids: ["E1", "E2"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result[0].verdict, "duplicate", result[0].reason);
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

test("a vague shared object cannot by itself prove that two reports are different", () => {
  const incoming = {
    title: "Guvernul anunță reducerea TVA la alimente",
    content: "Guvernul a anunțat reducerea TVA pentru alimente, în proiectul fiscal prezentat astăzi.",
  };
  const candidate = {
    title: "Guvernul anunță reducerea TVA la combustibil",
    content: "Guvernul a anunțat reducerea TVA pentru combustibil, în proiectul fiscal prezentat astăzi.",
  };
  const result = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "different",
    reason: "Obiectele măsurii sunt diferite.",
    incoming_fact: { actor: "Guvernul României", action: "anunță reducerea TVA", object: "TVA", stage: "proiect fiscal prezentat" },
    candidate_fact: { actor: "Guvernul României", action: "anunță reducerea TVA", object: "TVA", stage: "proiect fiscal prezentat" },
    incoming_evidence_ids: ["E2"],
    candidate_evidence_ids: ["E2"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result[0].verdict, "uncertain");
});

test("shared actor words cannot substitute for missing action, object, and stage evidence", () => {
  const incoming = {
    title: "Guvernul României anunță reducerea TVA la alimente",
    content: "Guvernul României a publicat astăzi un comunicat despre exporturile companiilor.",
  };
  const candidate = {
    title: "Guvernul României anunță reducerea TVA la combustibil",
    content: "Guvernul României a transmis luni un document despre importurile companiilor.",
  };
  const result = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "same_report",
    reason: "Aceeași măsură a Guvernului.",
    incoming_fact: { actor: "Guvernul României", action: "anunță reducerea TVA", object: "TVA pentru alimente", stage: "proiect fiscal" },
    candidate_fact: { actor: "Guvernul României", action: "anunță reducerea TVA", object: "TVA pentru alimente", stage: "proiect fiscal" },
    incoming_evidence_ids: ["E2"],
    candidate_evidence_ids: ["E2"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result[0].verdict, "uncertain");
  assert.match(result[0].reason, /nu susțin suficient fișele/);
});

test("same Nicușor Dan statement across two outlets keeps Gemini probability with evidence-backed duplicate", () => {
  const hotnews = {
    title: "Nicușor Dan, despre alegerile anticipate: Nu ne jucăm cu soarta țării",
    content: "Nicușor Dan a respins alegerile anticipate. A spus că ar urma cinci luni fără rectificare bugetară și a citat mesajul investitorilor: nu alegeri anticipate. „Nu ne jucăm cu soarta acestei țări ca să vedem ce iese dintr-o alegere.”",
  };
  const digi24 = {
    title: "Șeful statului: alegerile anticipate sună bine, dar în practică nu putem face rectificare",
    content: "Nicușor Dan a spus că alegerile anticipate ar însemna cinci luni fără rectificare bugetară și că mesajul primit de la investitori a fost «nu alegeri anticipate». „Nu ne jucăm de-a soarta acestei țări ca să vedem ce iese dintr-o alegere.”",
  };
  const [result] = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "same_report",
    duplicate_probability: 98,
    reason: "Ambele articole redau aceeași declarație despre respingerea anticipatelor și lipsa rectificării bugetare timp de cinci luni.",
    incoming_fact: { actor: "Nicușor Dan", action: "respinge alegerile anticipate", object: "cinci luni fără rectificare bugetară", stage: "declarație după eșecul Guvernului Mureșan" },
    candidate_fact: { actor: "Nicușor Dan", action: "respinge alegerile anticipate", object: "cinci luni fără rectificare bugetară", stage: "declarație după eșecul Guvernului Mureșan" },
    incoming_evidence_ids: ["E2"],
    candidate_evidence_ids: ["E2"],
  }] }), 1, hotnews, [digi24]);
  assert.equal(result.verdict, "duplicate");
  assert.equal(result.duplicateProbability, 98);
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

test("near-verbatim full article bodies rescue a duplicate when Gemini cites bad evidence IDs", () => {
  const sharedCopy = Array.from({ length: 120 }, (_, index) => `detaliu${index}`).join(" ");
  const incoming = { title: "Titlu reformulat A", content: sharedCopy };
  const candidate = { title: "Titlu reformulat B", content: sharedCopy.replaceAll(" ", " , ") };
  const [result] = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "same_report",
    reason: "Aceeași relatare.",
    incoming_fact: { actor: "autoritatea A", action: "decide", object: "eveniment", stage: "acum" },
    candidate_fact: { actor: "autoritatea B", action: "publică", object: "relatare", stage: "ieri" },
    incoming_evidence_ids: ["E99"],
    candidate_evidence_ids: ["E99"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result.verdict, "duplicate");
  assert.match(result.reason, /aproape integral același text/);
});

test("substantial syndication rescues a duplicate when the shorter outlet reuses most of its full text", () => {
  const sharedReport = Array.from({ length: 120 }, (_, index) => `reportaj${index}`).join(" ");
  const incomingOnly = Array.from({ length: 240 }, (_, index) => `detaliuNou${index}`).join(" ");
  const candidateOnly = Array.from({ length: 70 }, (_, index) => `detaliuReluat${index}`).join(" ");
  const incoming = { title: "Titlu A", content: `${sharedReport} ${incomingOnly}` };
  const candidate = { title: "Titlu B", content: `${sharedReport} ${candidateOnly}` };
  const [result] = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "duplicate",
    reason: "Ambele articole redau același material preluat.",
    incoming_fact: { actor: "sursă", action: "relatează", object: "reportaj", stage: "publicare" },
    candidate_fact: { actor: "sursă", action: "relatează", object: "reportaj", stage: "publicare" },
    incoming_evidence_ids: ["E99"],
    candidate_evidence_ids: ["E99"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result.verdict, "duplicate");
  assert.match(result.reason, /aproape integral același text/);
});

test("shared background alone cannot use the near-verbatim rescue for a duplicate", () => {
  const sharedContext = Array.from({ length: 120 }, (_, index) => `context${index}`).join(" ");
  const specificA = Array.from({ length: 120 }, (_, index) => `alpha${index}`).join(" ");
  const specificB = Array.from({ length: 120 }, (_, index) => `beta${index}`).join(" ");
  const incoming = { title: "Evenimentul A", content: `${sharedContext} ${specificA}` };
  const candidate = { title: "Evenimentul B", content: `${sharedContext} ${specificB}` };
  const [result] = parseSimilarityReview(JSON.stringify({ results: [{
    id: 1,
    verdict: "same_report",
    reason: "Au context comun.",
    incoming_fact: { actor: "actor A", action: "acțiunea A", object: "obiect A", stage: "etapa A" },
    candidate_fact: { actor: "actor B", action: "acțiunea B", object: "obiect B", stage: "etapa B" },
    incoming_evidence_ids: ["E99"],
    candidate_evidence_ids: ["E99"],
  }] }), 1, incoming, [candidate]);
  assert.equal(result.verdict, "uncertain");
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
