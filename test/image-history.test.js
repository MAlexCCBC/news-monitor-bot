import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {readRecentImages,cleanupImageHistory} from "../src/storage/image-history.js";

test("recently reused old photos remain visible and survive cleanup; dormant photos expire", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE image_history(image_url TEXT,person_or_topic TEXT,created_at INTEGER,used_count INTEGER,last_used INTEGER, visual_hash TEXT)");
    const now=Date.UTC(2026,9,2), day=86400000;
    const insert=db.prepare("INSERT INTO image_history VALUES (?, 'person', ?, 2, ?, NULL)");
    insert.run("reused",now-30*day,now-day);
    insert.run("dormant",now-30*day,now-20*day);
    insert.run("legacy",now-day,null);
    assert.deepEqual(readRecentImages(db,7,now).map(x=>x.image_url),["reused","legacy"]);
    cleanupImageHistory(db,7,now);
    assert.deepEqual(db.prepare("SELECT image_url FROM image_history").all().map(x=>x.image_url),["reused","legacy"]);
    assert.equal(readRecentImages(db,NaN,now).length,2);
  } finally {db.close();}
});
