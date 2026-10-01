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

test("freshness crosses midnight but rejects stale, future and missing dates", () => {
  const now = Date.parse("2026-10-02T00:10:00+03:00");
  assert.equal(publicationFreshness({ isoDate: "2026-10-01T23:50:00+03:00" }, { now }).fresh, true);
  assert.equal(publicationFreshness({ isoDate: "2026-10-01T09:00:00+03:00" }, { now }).reason, "stale_publication_date");
  assert.equal(publicationFreshness({ isoDate: "2026-10-02T08:00:00+03:00" }, { now }).reason, "future_publication_date");
  assert.equal(publicationFreshness({ isoDate: null }, { now }).reason, "missing_or_invalid_publication_date");
  assert.equal(publicationFreshness({ isoDate: "2026-10-01T09:00:00+03:00" }, { now, maxAgeHours: 24 }).fresh, true);
  assert.equal(publicationFreshness({ isoDate: "2026-10-01T09:00:00+03:00" }, { now, maxAgeHours: -1 }).fresh, false);
});

test("calendar-date compatibility helper rejects a future timestamp on the same day", () => {
  const now = Date.parse("2026-10-02T01:00:00+03:00");
  assert.equal(isPublishedToday("2026-10-02T00:30:00", now), true);
  assert.equal(isPublishedToday("2026-10-02T20:30:00", now), false);
});
