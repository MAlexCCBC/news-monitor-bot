import test from "node:test";
import assert from "node:assert/strict";

import { parseApprovalCallback } from "../src/telegram/approval-callback.js";

test("process and ignore callback payloads retain the full durable request ID", () => {
  assert.deepEqual(parseApprovalCallback("proc_a123xyz"), { action: "process", id: "a123xyz" });
  assert.deepEqual(parseApprovalCallback("ign_a123xyz"), { action: "ignore", id: "a123xyz" });
  assert.equal(parseApprovalCallback("other_a123xyz"), null);
});
