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

// Textul produs de model este afișat omului, deci trebuie igienizat: fără
// ghilimele din JSON, fără tag-uri HTML care ar rupe mesajul Telegram și
// limitat ca lungime. Nu inventăm conținut, doar curățăm ce a venit.
function modelText(value, limit = 300) {
  return escapeHtml(String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit));
}

export function formatApprovalText(item) {
  const title = escapeHtml(item.article?.title || "(fără titlu)");
  const comparisonTitle = escapeHtml(item.comparisonTitle || "Știre anterioară");
  const comparisonLabel = item.simResult?.isPendingApproval
    ? "Știre similară cu o cerere deja în așteptare"
    : "Știre similară deja procesată";
  const needsManualReview = item.simResult?.aiVerdict === "uncertain";
  const aiProbability = Number.isInteger(item.simResult?.aiSimilarityProbability)
    ? `${item.simResult.aiSimilarityProbability}% estimare Gemini`
    : null;
  const aiRationale = item.simResult?.aiRationale || (needsManualReview ? item.simResult?.similarityReason : null);
  const aiChecks = Array.isArray(item.simResult?.aiChecks) ? item.simResult.aiChecks : [];
  const score = aiProbability || (item.simResult?.similarityBasis === "ai_cross_embedding"
    ? (needsManualReview ? "neclar; verificare manuală" : "confirmat prin AI")
    : `${(Number(item.similarity || 0) * 100).toFixed(0)}%${needsManualReview ? " · verdict AI neclar" : item.simResult?.similarityBasis === "semantic_ai" ? " · confirmat prin AI" : ""}`);
  const currentLink = clickableUrl(item.url);
  // Older pending requests may predate the dedicated comparison_url field;
  // the similarity result already persisted the candidate URL in that case.
  const comparisonLink = clickableUrl(item.comparisonUrl || item.simResult?.similarUrl);
  // Fiecare stare primește o explicație scrisă pentru om, nu pentru alt model.
  // Un scor de similaritate de vector nu spune nimic despre evenimente, iar
  // amestecul lui cu o decizie automată îl făcea ilizibil.
  const aiVerdict = item.simResult?.aiVerdict;
  const comparisonNote = needsManualReview
    ? (aiRationale
        ? `Gemini nu a putut decide sigur dacă e aceeași informație. Motivul: ${modelText(aiRationale)}`
        : "Gemini nu a putut decide sigur dacă e aceeași informație. Verifică cele două linkuri.")
    : aiVerdict === "duplicate"
      ? "Gemini a comparat articolele integral și a confirmat că relatează același fapt."
      : ["different", "new_development", "related_context"].includes(aiVerdict)
        ? "Gemini a comparat articolele integral și a respins potrivirea ca duplicat."
        : aiVerdict === "unreviewed"
          ? "Candidatul nu a fost verificat de Gemini și nu este tratat ca duplicat."
          : "A fost găsit un candidat similar; verdictul Gemini nu este disponibil în această cerere.";
  const aiChecksExplanation = needsManualReview && aiChecks.length
    ? `\n\n<i>Verificări păstrate: ${aiChecks.map((check) => {
      const score = Number.isInteger(check.duplicateProbability) ? ` (${check.duplicateProbability}%)` : "";
      const reason = check.reason ? ` — ${modelText(check.reason, 200)}` : "";
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

  return `${needsManualReview ? "❔" : "⏭️"} <b>${needsManualReview ? `Verificare manuală${aiProbability ? ` · ${score}` : ""}` : `Posibil duplicat · ${score}`}</b>\n\n` +
    `<b>Comparație între link-uri</b>\n` +
    `<b>Link primit:</b> ${currentLink}\n` +
    `<b>${comparisonLabel}:</b> ${comparisonTitle} — ${comparisonLink}\n\n` +
    `<i>${comparisonNote}</i>${aiChecksExplanation}${relatedLinks}\n\n` +
    `<i>Dorești să fie procesată și trimisă oricum? Cererea expiră în 12 ore.</i>`;
}
