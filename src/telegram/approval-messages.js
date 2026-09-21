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
  const score = `${(Number(item.similarity || 0) * 100).toFixed(0)}%`;
  const currentLink = clickableUrl(item.url);
  // Older pending requests may predate the dedicated comparison_url field;
  // the similarity result already persisted the candidate URL in that case.
  const comparisonLink = clickableUrl(item.comparisonUrl || item.simResult?.similarUrl);

  if (item.kind === "ai_text") {
    const preview = escapeHtml((item.formattedPost || "").slice(0, 700));
    return `🤖⏭️ <b>Textul generat de AI pare similar (${score})</b>\n\n` +
      `<b>Comparație cu știri create deja cu AI</b>\n` +
      `<b>Știrea curentă:</b> ${title} — ${currentLink}\n` +
      `<b>Știre creată anterior cu AI:</b> ${comparisonTitle} — ${comparisonLink}\n\n` +
      `<b>Previzualizare:</b>\n${preview}\n\n` +
      `<i>Cererea nu expiră. Dorești să primești știrea oricum?</i>`;
  }

  return `⏭️ <b>Știre similară (${score})</b>\n\n` +
    `<b>Comparație între link-uri</b>\n` +
    `<b>Link primit:</b> ${currentLink}\n` +
    `<b>Știre/link similar deja procesat:</b> ${comparisonTitle} — ${comparisonLink}\n\n` +
    `<i>Dorești să fie procesată și trimisă oricum? Cererea expiră în 12 ore.</i>`;
}
