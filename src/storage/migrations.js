export function ensureColumn(db, table, name, definition) {
  const hasColumn = () => db.prepare(`PRAGMA table_info(${table})`).all()
    .some((column) => column.name === name);
  if (hasColumn()) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  } catch (error) {
    // Parallel test workers or bot instances can both inspect an old schema
    // before either ALTER commits. Accept the race only if the peer added the
    // exact column we needed; preserve every unrelated migration failure.
    if (!hasColumn()) throw error;
  }
}
