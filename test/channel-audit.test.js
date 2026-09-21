import test from "node:test";
import assert from "node:assert/strict";

import { formatChannelAudit } from "../src/telegram/channel-audit.js";

test("channel audit entries preserve source, link, outcome, and skip reason as searchable JSON", () => {
  const line = formatChannelAudit({
    channel: "mediafax",
    messageId: 42,
    title: "  Titlu știre  ",
    url: "https://mediafax.ro/stire",
    status: "skipped",
    reason: "Nu am găsit niciun keyword configurat în titlu sau lead.",
  });

  assert.match(line, /^\[channel-audit\] /);
  const record = JSON.parse(line.slice("[channel-audit] ".length));
  assert.deepEqual(record, {
    channel: "mediafax",
    messageId: 42,
    title: "Titlu știre",
    url: "https://mediafax.ro/stire",
    status: "skipped",
    reason: "Nu am găsit niciun keyword configurat în titlu sau lead.",
  });
});
