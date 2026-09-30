import "dotenv/config";
import { arbitrateSimilarity } from "../src/similarity/ai-arbitrator.js";

const model = process.env.SIMILARITY_BENCHMARK_MODEL || "gemini-3.5-flash-lite";

const batches = [
  {
    name: "criza politică și nominalizarea premierului",
    incoming: {
      title: "Nicușor Dan va consulta partidele luni și va nominaliza un premier",
      content: "Președintele Nicușor Dan a anunțat că va chema partidele la consultări luni dimineață. Luni după-amiază, șeful statului va face o nominalizare pentru funcția de prim-ministru.",
    },
    candidates: [
      {
        url: "https://fixture.invalid/duplicate-same-announcement",
        expected: "duplicate",
        title: "Președintele anunță consultări luni și desemnarea unui nou premier în aceeași zi",
        content: "Nicușor Dan a spus că luni dimineață va discuta cu partidele parlamentare. El a precizat că va nominaliza un candidat la funcția de premier luni după-amiază.",
      },
      {
        url: "https://fixture.invalid/false-positive-waiting-next-steps",
        expected: "distinct",
        title: "Siegfried Mureșan: Așteptăm să vedem care sunt pașii următori ai președintelui",
        content: "După votul din Parlament, Siegfried Mureșan a spus că PNL așteaptă să vadă ce va decide președintele. Declarația nu a anunțat o dată de consultări sau o nominalizare.",
      },
      {
        url: "https://fixture.invalid/false-positive-party-reaction",
        expected: "distinct",
        title: "Raluca Turcan spune ce ar trebui să facă PNL dacă Guvernul nu primește votul",
        content: "Raluca Turcan a declarat că partidul trebuie să analizeze opțiunile după votul de învestitură. Ea nu a relatat calendarul consultărilor prezidențiale și nici numele unui premier desemnat.",
      },
      {
        url: "https://fixture.invalid/false-positive-same-person-other-event",
        expected: "distinct",
        title: "Nicușor Dan a discutat cu președintele Cehiei despre securitatea regională",
        content: "În timpul vizitei oficiale la Praga, Nicușor Dan s-a întâlnit cu președintele ceh. Cei doi au discutat cooperarea economică și sprijinul pentru Ucraina.",
      },
    ],
  },
  {
    name: "măsuri fiscale și obiectul concret al măsurii",
    incoming: {
      title: "Guvernul anunță reducerea TVA la alimente",
      content: "Guvernul României a prezentat un proiect care reduce taxa pe valoarea adăugată pentru alimente. Măsura ar urma să intre în vigoare după adoptarea actului normativ.",
    },
    candidates: [
      {
        url: "https://fixture.invalid/duplicate-vat-food",
        expected: "duplicate",
        title: "Proiectul Guvernului prevede TVA mai mică pentru produsele alimentare",
        content: "Executivul a prezentat un proiect prin care taxa pe valoarea adăugată pentru produse alimentare va fi redusă. Aplicarea măsurii este prevăzută după adoptarea actului normativ.",
      },
      {
        url: "https://fixture.invalid/false-positive-vat-fuel",
        expected: "distinct",
        title: "Guvernul analizează reducerea TVA pentru combustibil",
        content: "Guvernul României analizează un proiect privind scăderea taxei pe valoarea adăugată pentru combustibil. Măsura ar urma să intre în vigoare după adoptarea actului normativ.",
      },
    ],
  },
];

function safeResult(result) {
  return {
    verdict: result?.verdict || "no_result",
    reason: result?.reason || "",
  };
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY lipsește din mediul local/.env; nu s-a trimis nicio cerere.");
    process.exitCode = 2;
    return;
  }

  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let manual = 0;
  let failed = 0;
  const rows = [];

  for (const batch of batches) {
    const { incoming, candidates } = batch;
    let results = null;
    try {
      const review = await arbitrateSimilarity(incoming, candidates, {
        models: [model],
        modelFilter: async (requested) => requested,
      });
      results = review?.results || null;
    } catch (error) {
      rows.push({ batch: batch.name, error: String(error?.message || error) });
    }

    if (!results || results.length !== candidates.length) {
      failed += candidates.length;
      rows.push(...candidates.map((candidate) => ({
        batch: batch.name,
        candidate: candidate.url,
        expected: candidate.expected,
        actual: "request_failed",
      })));
      continue;
    }

    results.forEach((result, index) => {
      const candidate = candidates[index];
      const actual = safeResult(result);
      const isPositive = actual.verdict === "duplicate";
      if (actual.verdict === "uncertain") manual++;
      else if (candidate.expected === "duplicate" && isPositive) truePositive++;
      else if (candidate.expected === "duplicate") falseNegative++;
      else if (isPositive) falsePositive++;
      rows.push({
        batch: batch.name,
        candidate: candidate.url,
        expected: candidate.expected,
        actual: actual.verdict,
        reason: actual.reason,
      });
    });
  }

  console.log(JSON.stringify({ model, rows, metrics: { truePositive, falsePositive, falseNegative, manual, failed } }, null, 2));
  if (falsePositive || falseNegative || failed) process.exitCode = 1;
}

await main();
