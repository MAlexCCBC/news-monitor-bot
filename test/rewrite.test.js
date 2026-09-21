import test from "node:test";
import assert from "node:assert/strict";

import { isCompleteRewrite } from "../src/ai/rewrite.js";

const completePost = `📰 TITLU DE TEST\nContextul articolului.\n\n📌 Ideile principale:\n• 🔹 Primul punct complet.\n• 🔹 Al doilea punct complet.\n• 🔹 Al treilea punct complet.\nOficialul a declarat că situația continuă.\n💬 Ce părere aveți?\n\n👇 Așteptăm opinia ta în comentarii!`;

test("rewrite is complete only with a natural stop, three points, and the final footer", () => {
  assert.equal(isCompleteRewrite(completePost, "STOP"), true);
  assert.equal(isCompleteRewrite(completePost.slice(0, -20), "STOP"), false);
  assert.equal(isCompleteRewrite(completePost.replace("• 🔹 Al treilea punct complet.\n", ""), "STOP"), false);
  assert.equal(isCompleteRewrite(completePost, "MAX_TOKENS"), false);
});
