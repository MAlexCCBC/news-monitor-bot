// A few publishers keep the numeric article ID stable while changing the
// route/title slug as an article is updated. Treat those URLs as one article,
// but never equate IDs across different publisher hosts.
export function articleUrlIdentity(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return String(rawUrl || "");

    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let pathname = url.pathname;
    try { pathname = decodeURIComponent(pathname); } catch {}
    pathname = pathname.replace(/\/+$/, "").toLowerCase();

    const lastSegment = pathname.split("/").at(-1) || "";
    const articleId = lastSegment.replace(/\.html?$/i, "").match(/(?:^|[-_])(\d{5,})$/)?.[1];
    if (articleId) return `${host}:article:${articleId}`;

    return `${host}${pathname || "/"}`;
  } catch {
    return String(rawUrl || "").trim();
  }
}

export function sameArticleUrl(left, right) {
  return articleUrlIdentity(left) === articleUrlIdentity(right);
}
