// Drizzle (mysql2 driver) resolves INSERT/UPDATE queries as the tuple
// [ResultSetHeader, FieldPacket[]]. Several call sites historically read
// .insertId / .affectedRows directly off that tuple (always undefined) and
// relied on fallback SELECTs to recover the row. Extract the header instead
// so the primary path works and the fallbacks become true safety nets.

interface ResultSetHeaderLike {
  insertId?: number | bigint;
  affectedRows?: number;
}

function resolveHeader(result: unknown): ResultSetHeaderLike | undefined {
  return (Array.isArray(result) ? result[0] : result) as
    | ResultSetHeaderLike
    | undefined;
}

/** Returns the auto-increment id of an INSERT result, or undefined if absent. */
export function extractInsertId(result: unknown): number | undefined {
  const insertId = resolveHeader(result)?.insertId;
  return insertId === undefined ? undefined : Number(insertId);
}

/** Returns the affected-row count of an INSERT/UPDATE result (0 if absent). */
export function extractAffectedRows(result: unknown): number {
  return Number(resolveHeader(result)?.affectedRows ?? 0);
}
