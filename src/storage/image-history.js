export function readRecentImages(db, daysBack, now = Date.now()) {
  const days = Number(daysBack);
  const cutoff = now - (Number.isFinite(days) && days > 0 ? days : 7) * 86400000;
  return db.prepare(`
    SELECT image_url, person_or_topic, used_count, last_used
    FROM image_history WHERE COALESCE(last_used, created_at) >= ?
  `).all(cutoff);
}

export function cleanupImageHistory(db, daysBack, now = Date.now()) {
  const days = Number(daysBack);
  const cutoff = now - (Number.isFinite(days) && days > 0 ? days : 7) * 86400000 * 2;
  return db.prepare("DELETE FROM image_history WHERE COALESCE(last_used, created_at) < ?").run(cutoff);
}
