import test from "node:test";
import assert from "node:assert/strict";

import { isVerifiedPersonImageAllowed, shouldUseArticleThumbnail } from "../src/image/policy.js";

test("a person search result is allowed only after a positive face match against a reference", () => {
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: true, samePerson: true, hasText: false }), true);
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: false, samePerson: true, hasText: false }), false);
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: true, samePerson: null, hasText: null }), false);
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: true, samePerson: false, hasText: false }), false);
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: true, samePerson: true, hasText: true }), false);
});

test("unverified article thumbnails are never sent as images", () => {
  assert.equal(shouldUseArticleThumbnail({ speaker: "Claudiu Manda", imageUrl: "https://example.com/thumbnail.jpg" }), false);
  assert.equal(shouldUseArticleThumbnail({ speaker: null, imageUrl: "https://example.com/thumbnail.jpg" }), false);
  assert.equal(shouldUseArticleThumbnail({ speaker: null, title: "Manda: al doilea eurodeputat criticat", imageUrl: "https://example.com/document.jpg" }), false);
  assert.equal(shouldUseArticleThumbnail({ speaker: null, title: "Claudiu Manda a declarat că demisionează", imageUrl: "https://example.com/document.jpg" }), false);
  assert.equal(shouldUseArticleThumbnail({ speaker: null, imageUrl: null }), false);
});
