import test from "node:test";
import assert from "node:assert/strict";
import { imageIdentity, recentImageKeys, diverseImageCandidates, commonsPhotoCandidates } from "../src/image/selection.js";

test("Commons thumbnails and WordPress size variants retain photograph identity", () => {
  const original = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Test.jpg";
  assert.equal(imageIdentity(original), imageIdentity("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Test.jpg/800px-Test.jpg"));
  assert.equal(imageIdentity("https://example.com/photo.jpg"), imageIdentity("https://example.com/photo-800x600.jpg?w=320&utm_source=feed"));
  assert.notEqual(imageIdentity("https://example.com/photo.jpg?id=1"), imageIdentity("https://example.com/photo.jpg?id=2"));
});

test("recent resolution variants are excluded and providers share the candidate budget", () => {
  const used = recentImageKeys([{image_url:"https://example.com/old.jpg"}]);
  const pools = [["https://example.com/old-800x600.jpg", "https://a/new.jpg", "https://a/next.jpg"],
    ["https://b/new.jpg", "https://b/next.jpg"], ["https://c/new.jpg"]];
  assert.deepEqual(diverseImageCandidates(pools, used, 3), ["https://b/new.jpg","https://c/new.jpg","https://a/new.jpg"]);
  assert.deepEqual(diverseImageCandidates(pools, used, 0), []);
});

test("Commons prefers capture dates, excludes small/non-photo files and does not confuse upload dates", () => {
  const photo = (url, date, timestamp="2026-10-02T00:00:00Z") => ({imageinfo:[{url, mime:"image/jpeg", width:800,height:900,timestamp,extmetadata:{DateTimeOriginal:{value:date}}}]});
  const old = photo("https://x/old.jpg", "2010-01-01");
  const recent = photo("https://x/recent.jpg", "2026-09-29 12:00:00");
  const unknown = photo("https://x/unknown.jpg", "<span>unknown</span>");
  const small = photo("https://x/small.jpg","2026-10-01"); small.imageinfo[0].width=80;
  const logo = photo("https://x/logo.svg","2026-10-01"); logo.imageinfo[0].mime="image/svg+xml";
  assert.deepEqual(commonsPhotoCandidates([old,unknown,small,logo,recent]), ["https://x/recent.jpg","https://x/old.jpg","https://x/unknown.jpg"]);
});
