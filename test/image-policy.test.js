import test from "node:test";
import assert from "node:assert/strict";

import { isArticleImageCandidate, isVerifiedPersonImageAllowed } from "../src/image/policy.js";

test("person image requires positive identity verification and no visible overlay text", () => {
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: true, samePerson: true, hasText: false }), true);
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: false, identityByName: true, samePerson: true, hasText: false }), true);
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: false, samePerson: true, hasText: false }), false);
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: false, identityByName: true, samePerson: null, hasText: null }), false);
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: false, identityByName: true, samePerson: false, hasText: false }), false);
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: false, identityByName: true, samePerson: true, hasText: true }), false);
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: true, samePerson: null, hasText: null }), false);
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: true, samePerson: false, hasText: false }), false);
  assert.equal(isVerifiedPersonImageAllowed({ hasReference: true, samePerson: true, hasText: true }), false);
});

test("article thumbnails are only candidates when a named speaker can be facially verified", () => {
  assert.equal(isArticleImageCandidate({ speaker: "Claudiu Manda", imageUrl: "https://example.com/thumbnail.jpg" }), true);
  assert.equal(isArticleImageCandidate({ speaker: null, imageUrl: "https://example.com/thumbnail.jpg" }), false);
  assert.equal(isArticleImageCandidate({ speaker: "Claudiu Manda", imageUrl: "file:///thumbnail.jpg" }), false);
  assert.equal(isArticleImageCandidate({ speaker: "Claudiu Manda", imageUrl: null }), false);
});
