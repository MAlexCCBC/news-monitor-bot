// Identity for known image transformations; preserve unknown query parameters.
export function imageIdentity(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return String(value);
    let pathname = decodeURIComponent(url.pathname);
    if (url.hostname === "upload.wikimedia.org") {
      pathname = pathname.replace(/\/thumb\//, "/").replace(/\/(?:\d+px-|page\d+-\d+px-)[^/]+$/, "");
    }
    // WordPress generates these size variants from the same original upload.
    pathname = pathname.replace(/-\d{2,5}x\d{2,5}(?=\.(?:jpe?g|png|webp)$)/i, "");
    for (const key of ["w", "h", "width", "height", "resize", "fit", "quality", "q", "utm_source", "utm_medium", "utm_campaign"]) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.hostname.toLowerCase() + pathname + (url.searchParams.size ? "?" + url.searchParams.toString() : "");
  } catch { return String(value || ""); }
}

export function recentImageKeys(history) {
  return new Set(history.map(item => imageIdentity(item.image_url)));
}

// Round-robin avoids exhausting the vision budget on one search provider.
export function diverseImageCandidates(pools, usedKeys = new Set(), limit = 12) {
  const result = [];
  const seen = new Set(usedKeys);
  const longest = Math.max(0, ...pools.map(pool => pool.length));
  for (let rank = 0; rank < longest && result.length < limit; rank++) {
    for (const pool of pools) {
      const url = pool[rank];
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
      const key = imageIdentity(url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(url);
      if (result.length === limit) break;
    }
  }
  return result;
}

export function commonsPhotoCandidates(pages) {
  return pages.map(page => {
    const info = page.imageinfo?.[0];
    const url = info?.thumburl || info?.url;
    const rawDate = info?.extmetadata?.DateTimeOriginal?.value;
    // Upload/modification timestamps are not the date a photograph was taken.
    const takenAt = typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(rawDate)
      ? Date.parse(rawDate.replace(" ", "T") + (rawDate.length === 19 ? "Z" : "")) : NaN;
    return { url, info, takenAt };
  }).filter(({ url, info }) => typeof url === "string" && /^https?:\/\//.test(url) &&
    /^image\/(?:jpeg|png|webp)$/.test(info.mime || "") && info.width >= 320 && info.height >= 320)
    .sort((a, b) => (Number.isFinite(b.takenAt) ? b.takenAt : 0) - (Number.isFinite(a.takenAt) ? a.takenAt : 0))
    .map(item => item.url);
}
