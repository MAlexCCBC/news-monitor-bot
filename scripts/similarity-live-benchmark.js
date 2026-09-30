import "dotenv/config";
import { arbitrateSimilarity } from "../src/similarity/ai-arbitrator.js";

const models = (process.env.SIMILARITY_BENCHMARK_MODELS || process.env.SIMILARITY_BENCHMARK_MODEL || "gemini-3.5-flash-lite")
  .split(",").map((name) => name.trim()).filter(Boolean);
const selectedBatch = Number.parseInt(process.env.SIMILARITY_BENCHMARK_BATCH || "0", 10);

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
  {
    name: "starea de urgență energetică și hidrologică din Republica Moldova",
    incoming: {
      title: "Maia Sandu anunță stare de urgență energetică și hidrologică în Republica Moldova",
      content: "Președinta Maia Sandu a spus că Guvernul va solicita Parlamentului instituirea stării de urgență în domeniul energetic și hidrologic. Măsura vine pe fondul riscurilor pentru aprovizionarea cu energie și al situației hidrologice.",
    },
    candidates: [
      {
        url: "https://fixture.invalid/duplicate-moldova-state-of-emergency",
        expected: "duplicate",
        title: "Republica Moldova va institui stare de urgență în domeniile energetic și hidrologic",
        content: "Maia Sandu a anunțat că Executivul va cere Parlamentului să declare stare de urgență energetică și hidrologică. Decizia este legată de riscurile de aprovizionare și de evoluția situației hidrologice.",
      },
      {
        url: "https://fixture.invalid/false-positive-romania-crisis-support",
        expected: "distinct",
        title: "România face parte din planul de criză pentru sprijinirea Republicii Moldova",
        content: "Autoritățile române au discutat măsuri de sprijin pentru Republica Moldova în cazul unor probleme de aprovizionare. Articolul descrie contribuția României, nu anunțul Maiei Sandu privind declararea stării de urgență.",
      },
      {
        url: "https://fixture.invalid/false-positive-later-parliamentary-vote",
        expected: "distinct",
        title: "Parlamentul Republicii Moldova votează instituirea stării de urgență energetică",
        content: "După solicitarea Guvernului, deputații au votat instituirea stării de urgență. Articolul relatează votul și durata măsurii, ca etapă ulterioară anunțului prezidențial.",
      },
    ],
  },
  {
    name: "declarațiile lui Siegfried Mureșan despre OUG 13 și criza guvernamentală",
    incoming: {
      title: "Siegfried Mureșan îi spune lui Grindeanu că nu a învățat nimic din OUG 13",
      content: "Siegfried Mureșan a afirmat că Sorin Grindeanu nu a învățat nimic din perioada OUG 13. El a avertizat că Grindeanu nu ar ezita să emită o nouă ordonanță pro-furt dacă PSD ar reveni la guvernare.",
    },
    candidates: [
      {
        url: "https://fixture.invalid/duplicate-muresan-oug13",
        expected: "duplicate",
        title: "Mureșan: Grindeanu nu regretă OUG 13 și ar putea repeta ordonanța pro-furt",
        content: "Liberalul Siegfried Mureșan a declarat că liderul PSD nu a învățat din episodul OUG 13 și că, dacă ar reveni la putere, ar putea adopta din nou o ordonanță pro-furt.",
      },
      {
        url: "https://fixture.invalid/false-positive-muresan-anticipates",
        expected: "distinct",
        title: "Dan Motreanu: alegerile anticipate pot schimba realitatea politică",
        content: "Secretarul general al PNL, Dan Motreanu, a declarat că anticipatele pot schimba realitatea politică. El a vorbit despre alegeri ca mecanism de selecție internă a liderilor.",
      },
      {
        url: "https://fixture.invalid/false-positive-muresan-votes",
        expected: "distinct",
        title: "Siegfried Mureșan spune că se bazează pe 200 de voturi pentru învestirea Guvernului",
        content: "Premierul desemnat a vorbit despre calculele parlamentare și despre numărul de voturi necesare pentru învestirea cabinetului. Articolul nu discută OUG 13 sau declarațiile lui Grindeanu despre proteste.",
      },
      {
        url: "https://fixture.invalid/false-positive-grindeanu-complaint",
        expected: "distinct",
        title: "Sorin Grindeanu anunță că va depune plângere penală împotriva lui Dominic Fritz",
        content: "Liderul PSD a anunțat că se va consulta cu avocații pentru o plângere penală împotriva liderului USR. Disputa privește acuzațiile despre întâlnirea cu ambasadoarea SUA, nu OUG 13.",
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

  if (!models.length || models.some((name) => !name.startsWith("gemini-"))) {
    console.error("Benchmark-ul acceptă numai modele Gemini; niciun model non-Gemini nu va fi apelat.");
    process.exitCode = 2;
    return;
  }
  if (!Number.isInteger(selectedBatch) || selectedBatch < 0 || selectedBatch > batches.length) {
    console.error(`SIMILARITY_BENCHMARK_BATCH trebuie să fie între 1 și ${batches.length}, sau 0 pentru toate loturile.`);
    process.exitCode = 2;
    return;
  }

  const batchesToRun = selectedBatch ? [batches[selectedBatch - 1]] : batches;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let manual = 0;
  let failed = 0;
  const rows = [];

  for (const batch of batchesToRun) {
    const { incoming, candidates } = batch;
    let results = null;
    try {
      const review = await arbitrateSimilarity(incoming, candidates, {
        models,
        modelFilter: async (requested) => requested,
      });
      results = review?.results || null;
      if (review?.model) batch.usedModel = review.model;
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
        modelsTried: models,
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
        model: batch.usedModel || null,
        candidate: candidate.url,
        expected: candidate.expected,
        actual: actual.verdict,
        reason: actual.reason,
      });
    });
  }

  console.log(JSON.stringify({ models, selectedBatch: selectedBatch || "all", rows, metrics: { truePositive, falsePositive, falseNegative, manual, failed } }, null, 2));
  if (falsePositive || falseNegative || failed) process.exitCode = 1;
}

await main();
