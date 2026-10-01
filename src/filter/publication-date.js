const TIME_ZONE = "Europe/Bucharest";
const localParts = (timestamp) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).formatToParts(timestamp).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));

// Publishers commonly omit the offset (WordPress date). Interpret those
// timestamps in Romania, never in the Actions runner's UTC timezone. Avoid
// Date.parse's permissive rollover of invalid dates and locale ambiguity.
export function parsePublicationDate(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (!match) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", fraction = "", offset] = match;
  const parts = [y, mo, d, h, mi, s].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  if (year < 1900 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, "0")));
  const valid = new Date(wall);
  if (valid.getUTCMonth() !== month - 1 || valid.getUTCDate() !== day) return null;
  if (offset) {
    if (offset.toUpperCase() === "Z") return wall;
    const zone = offset.match(/^([+-])(\d{2}):?(\d{2})$/);
    if (!zone || Number(zone[2]) > 14 || Number(zone[3]) > 59 || (Number(zone[2]) === 14 && Number(zone[3]) !== 0)) return null;
    return wall - (zone[1] === "+" ? 1 : -1) * (Number(zone[2]) * 60 + Number(zone[3])) * 60_000;
  }
  let timestamp = wall;
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = localParts(timestamp);
    timestamp += wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, Number(fraction.padEnd(3, "0")));
  }
  const actual = localParts(timestamp);
  if ([actual.year, actual.month, actual.day, actual.hour, actual.minute, actual.second].some((part, i) => part !== parts[i])) return null;
  return timestamp;
}

export function publicationFreshness(article, {
  now = Date.now(), maxAgeHours = Number(process.env.ARTICLE_MAX_AGE_HOURS || 12),
  futureToleranceMs = 5 * 60_000,
} = {}) {
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) maxAgeHours = 12;
  const timestamp = parsePublicationDate(article?.isoDate);
  if (timestamp === null) return { fresh: false, reason: "missing_or_invalid_publication_date" };
  const ageMs = now - timestamp;
  if (ageMs < -futureToleranceMs) return { fresh: false, reason: "future_publication_date", timestamp, ageHours: ageMs / 3_600_000 };
  if (ageMs > maxAgeHours * 3_600_000) return { fresh: false, reason: "stale_publication_date", timestamp, ageHours: ageMs / 3_600_000 };
  return { fresh: true, reason: "recent_publication", timestamp, ageHours: Math.max(0, ageMs / 3_600_000) };
}
