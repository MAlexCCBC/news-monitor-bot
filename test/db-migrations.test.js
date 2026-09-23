import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { ensureColumn } from "../src/storage/migrations.js";

test("schema migration tolerates another worker adding the requested column concurrently", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE image_history (id INTEGER PRIMARY KEY, image_url TEXT)");
  let simulateConcurrentWinner = true;
  const racingDb = {
    prepare: db.prepare.bind(db),
    exec(sql) {
      if (simulateConcurrentWinner && sql.includes("ADD COLUMN used_count")) {
        simulateConcurrentWinner = false;
        db.exec(sql);
        throw new Error("duplicate column name: used_count");
      }
      return db.exec(sql);
    },
  };

  assert.doesNotThrow(() => ensureColumn(racingDb, "image_history", "used_count", "INTEGER NOT NULL DEFAULT 1"));
  assert.equal(db.prepare("PRAGMA table_info(image_history)").all().filter((column) => column.name === "used_count").length, 1);
  const brokenDb = { prepare: db.prepare.bind(db), exec() { throw new Error("disk I/O error"); } };
  assert.throws(() => ensureColumn(brokenDb, "image_history", "other_column", "TEXT"), /disk I\/O error/);
  db.close();
});
