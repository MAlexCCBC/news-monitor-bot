import test from "node:test";
import assert from "node:assert/strict";

import { articleUrlIdentity, sameArticleUrl } from "../src/utils/article-url.js";

test("Digi24 slug and route changes retain the same numeric article identity", () => {
  const earlier = "https://www.digi24.ro/stiri/actualitate/ccr-discuta-sesizarea-lui-bolojan-3960029";
  const updated = "https://www.digi24.ro/stiri/ccr-a-amanat-pentru-30-septembrie-decizia-3960029?utm_source=telegram";

  assert.equal(articleUrlIdentity(earlier), "digi24.ro:article:3960029");
  assert.equal(sameArticleUrl(earlier, updated), true);
});

test("article IDs are scoped to their publisher and unrelated IDs remain distinct", () => {
  assert.equal(sameArticleUrl("https://digi24.ro/news-3960029", "https://hotnews.ro/news-3960029"), false);
  assert.equal(sameArticleUrl("https://digi24.ro/news-3960029", "https://digi24.ro/news-3960035"), false);
});

test("URLs without a numeric article ID use their normalized host and path", () => {
  assert.equal(sameArticleUrl("https://www.g4media.ro/story.html?utm_source=x", "https://g4media.ro/story.html#top"), true);
  assert.equal(sameArticleUrl("https://g4media.ro/first.html", "https://g4media.ro/second.html"), false);
});
