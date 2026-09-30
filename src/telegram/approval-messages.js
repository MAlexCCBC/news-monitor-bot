function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clickableUrl(value) {
  if (!value) return "<i>link indisponibil</i>";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return escapeHtml(value);
    const url = escapeHtml(parsed.href);
    return `<a href="${url}">${url}</a>`;
  } catch {
    return escapeHtml(value);
  }
}

export function formatApprovalText(item) {
  const title = escapeHtml(item.article?.title || "(fără titlu)");
  const comparisonTitle = escapeHtml(item.comparisonTitle || "Știre anterioară");
  const comparisonLabel = item.simResult?.isPendingApproval
    ? "Știre/link similar cu aprobare deja în așteptare"
    : "Știre/link similar deja procesat";
  const needsManualReview = item.simResult?.aiVerdict === "uncertain";
  const aiProbability = Number.isInteger(item.simResult?.aiSimilarityProbability)
    ? `${item.simResult.aiSimilarityProbability}% estimare Gemini`
    : null;
  const aiRationale = item.simResult?.aiRationale || (needsManualReview ? item.simResult?.similarityReason : null);
  const aiChecks = Array.isArray(item.simResult?.aiChecks) ? item.simResult.aiChecks : [];
  const score = aiProbability || (item.simResult?.similarityBasis === "ai_cross_embedding"
    ? (needsManualReview ? "neclar; verificare manuală" : "confirmat prin AI")
    : `${(Number(item.similarity || 0) * 100).toFixed(0)}%${needsManualReview ? " · verdict AI neclar" : item.simResult?.similarityBasis === "semantic_ai" ? " · confirmat prin AI" : ""}`);
  const comparisonNote = item.simResult?.similarityBasis === "ai_cross_embedding"
    ? (aiProbability
      ? `Estimarea Gemini privește dacă este aceeași informație jurnalistică; nu este o probabilitate statistică calibrată.${needsManualReview ? ` Modelul a sugerat „${escapeHtml(item.simResult?.aiSuggestedVerdict || "incert")}", dar verificarea dovezilor cere confirmare manuală.` : ""}`
      : needsManualReview
      ? "Modelele nu au putut decide dacă textele integrale descriu același eveniment; verifică ambele linkuri înainte de alegere."
      : "Verdict AI bazat pe comparația textelor integrale; vectorii de embedding provin din modele incompatibile.")
    : (aiProbability
      ? `Estimarea Gemini privește dacă este aceeași informație jurnalistică; nu este o probabilitate statistică calibrată.${needsManualReview ? ` Modelul a sugerat „${escapeHtml(item.simResult?.aiSuggestedVerdict || "incert")}", dar verificarea dovezilor cere confirmare manuală.` : ""}`
      : needsManualReview
      ? "Scorul semantic este apropierea vectorilor, nu probabilitate; comparația AI a rămas neconcludentă, deci este necesară verificarea manuală."
      : "Scorul semantic este apropierea vectorilor, nu probabilitate; decizia include comparația articolelor complete.");
  const currentLink = clickableUrl(item.url);
  // Older pending requests may predate the dedicated comparison_url field;
  // the similarity result already persisted the candidate URL in that case.
  const comparisonLink = clickableUrl(item.comparisonUrl || item.simResult?.similarUrl);
  const aiExplanation = needsManualReview && aiRationale
    ? `\n\n<i>Explicația Gemini: ${escapeHtml(aiRationale)}</i>`
    : "";
  const aiChecksExplanation = needsManualReview && aiChecks.length
    ? `\n\n<i>Verificări păstrate: ${aiChecks.map((check) => {
      const score = Number.isInteger(check.duplicateProbability) ? ` (${check.duplicateProbability}%)` : "";
      const reason = check.reason ? ` — ${escapeHtml(check.reason)}` : "";
      return `${escapeHtml(check.model)}: ${escapeHtml(check.validatedVerdict || check.verdict)}${score}${reason}`;
    }).join("; ")}</i>`
    : "";
  const relatedLinks = (item.relatedArticles || []).length
    ? `\n\n<b>Linkuri suplimentare confirmate ca aceeași știre:</b>\n${item.relatedArticles
      .map((related) => `• ${escapeHtml(related.article?.title || "Articol")}: ${clickableUrl(related.url)}`)
      .join("\n")}`
    : "";

  if (item.kind === "ai_text") {
    const preview = escapeHtml((item.formattedPost || "").slice(0, 700));
    return `📝 <b>Text pregătit pentru trimitere</b>\n\n` +
      `<b>Știrea curentă:</b> ${title} — ${currentLink}\n` +
      `<b>Previzualizare:</b>\n${preview}\n\n` +
      `<i>Filtrul pe texte AI a fost eliminat. Poți reîncerca trimiterea textului salvat.</i>`;
  }

  return `${needsManualReview ? "❔" : "⏭️"} <b>${needsManualReview ? `Similaritate neclară — verificare manuală${aiProbability ? ` · ${score}` : ""}` : `Posibil duplicat · ${score}`}</b>\n\n` +
    `<b>Comparație între link-uri</b>\n` +
    `<b>Link primit:</b> ${currentLink}\n` +
    `<b>${comparisonLabel}:</b> ${comparisonTitle} — ${comparisonLink}\n\n` +
    `<i>${comparisonNote}</i>${aiExplanation}${aiChecksExplanation}${relatedLinks}\n\n` +
    `<i>Dorești să fie procesată și trimisă oricum? Cererea expiră în 12 ore.</i>`;
}
