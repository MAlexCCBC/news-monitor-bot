import test from "node:test";
import assert from "node:assert/strict";
import { parsePublicationDate, publicationFreshness } from "../src/filter/publication-date.js";
import { isPublishedToday } from "../src/filter/keywords.js";

test("timezone-less publisher dates use Bucharest regardless of runner timezone", () => {
  assert.equal(parsePublicationDate("2026-10-02T01:00:00"), Date.parse("2026-10-01T22:00:00Z"));
  assert.equal(parsePublicationDate("2026-01-02T01:00:00"), Date.parse("2026-01-01T23:00:00Z"));
  assert.equal(parsePublicationDate("2026-10-02"), Date.parse("2026-10-01T21:00:00Z"));
});

test("publication parser rejects rolled-over dates, DST gaps and malformed offsets", () => {
  for (const date of ["2026-02-30T12:00:00Z", "2026-13-01", "2026-10-01T24:00:00Z", "2026-10-01T00:00:00+03:99", "2026-03-29T03:30:00", "01/10/2026", null, ""]) {
    assert.equal(parsePublicationDate(date), null, String(date));
  }
  assert.equal(parsePublicationDate("2024-02-29T12:00:00.125Z"), Date.parse("2024-02-29T12:00:00.125Z"));
});

test("calendar freshness rejects yesterday even just across Romanian midnight", () => {
  const now = Date.parse("2026-10-02T00:10:00+03:00");
  assert.equal(publicationFreshness({ isoDate: "2026-10-01T23:50:00+03:00" }, { now }).reason, "previous_publication_day");
  assert.equal(publicationFreshness({ isoDate: "2026-10-01T09:00:00+03:00" }, { now, maxAgeHours: 24 }).fresh, false);
  assert.equal(publicationFreshness({ isoDate: "2026-10-03" }, { now }).reason, "future_publication_day");
  assert.equal(publicationFreshness({ isoDate: null }, { now }).reason, "missing_or_invalid_publication_date");
});

test("today's date is accepted without requiring the publication hour", () => {
  const now = Date.parse("2026-10-02T23:30:00+03:00");
  for (const isoDate of ["2026-10-02", "2026-10-02T00:15:00+03:00", "2026-10-02T07:00:00"]) {
    assert.equal(publicationFreshness({ isoDate }, { now }).fresh, true, isoDate);
  }
});

test("calendar-date compatibility helper ignores hours on the same day", () => {
  const now = Date.parse("2026-10-02T01:00:00+03:00");
  assert.equal(isPublishedToday("2026-10-02T00:30:00", now), true);
  assert.equal(isPublishedToday("2026-10-02T20:30:00", now), true);
});

test("UTC publication dates are compared by their Romanian calendar day", () => {
  const now = Date.parse("2026-10-02T01:00:00+03:00");
  assert.equal(publicationFreshness({ isoDate: "2026-10-01T22:30:00Z" }, { now }).fresh, true);
  assert.equal(publicationFreshness({ isoDate: "2026-10-01T20:30:00Z" }, { now }).fresh, false);
});

test("hour checks only apply when a caller explicitly requests them", () => {
  const now = Date.parse("2026-10-02T18:00:00+03:00");
  const morning = { isoDate: "2026-10-02T01:00:00+03:00" };
  assert.equal(publicationFreshness(morning, { now }).fresh, true);
  assert.equal(publicationFreshness(morning, { now, maxAgeHours: 12 }).reason, "stale_publication_date");
  assert.equal(publicationFreshness(morning, { now, maxAgeHours: -1 }).fresh, true);
  const laterToday = { isoDate: "2026-10-02T20:00:00+03:00" };
  assert.equal(publicationFreshness(laterToday, { now }).fresh, true);
  assert.equal(publicationFreshness(laterToday, { now, futureToleranceMs: 300000 }).reason, "future_publication_date");
});

test("legacy age env cannot silently re-enable hourly rejection", () => {
  const original = process.env.ARTICLE_MAX_AGE_HOURS;
  process.env.ARTICLE_MAX_AGE_HOURS = "1";
  try {
    assert.equal(publicationFreshness({ isoDate: "2026-10-02" }, { now: Date.parse("2026-10-02T18:00:00+03:00") }).fresh, true);
  } finally {
    if (original === undefined) delete process.env.ARTICLE_MAX_AGE_HOURS;
    else process.env.ARTICLE_MAX_AGE_HOURS = original;
  }
});
