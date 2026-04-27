import type { Database } from "sqlite";

/**
 * Per-connection write chain. We reuse a single SQLite connection across the
 * whole extension (sqlite3's node driver does not support concurrent
 * transactions on one connection) so every logical transaction must be
 * serialized. The chain is keyed on the `Database` instance via a `WeakMap`
 * so it never leaks between different extension hosts / test databases.
 */
const writeChain = new WeakMap<Database, Promise<unknown>>();

/**
 * Serializes a multi-statement write inside a single `BEGIN IMMEDIATE` …
 * `COMMIT` pair against the given connection.
 *
 * Guarantees:
 *  - At most one outstanding transaction on `db` at any moment. Overlapping
 *    callers line up behind each other instead of racing into
 *    `SQLITE_ERROR: cannot start a transaction within a transaction`.
 *  - Automatic `ROLLBACK` (best-effort) if `fn` throws.
 *  - A failed transaction does not poison the chain — subsequent calls
 *    still get their turn.
 *
 * Rule of thumb: wrap every write that does two-or-more statements in a
 * single call with this helper. Single-statement writes (one INSERT/UPDATE)
 * are already atomic and don't need it.
 */
export async function runSerializedTxn<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  const prev = writeChain.get(db) ?? Promise.resolve();

  const next = prev.then(async () => {
    await db.run("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      await db.run("COMMIT");
      return result;
    } catch (error) {
      await db.run("ROLLBACK").catch(() => {
        // Best-effort; the real error below is what callers care about.
      });
      throw error;
    }
  });

  // Swallow rejection on the stored chain so a failed txn doesn't break every
  // subsequent one — the thrown error is still surfaced to the actual caller
  // through `next` above.
  writeChain.set(
    db,
    next.catch(() => undefined)
  );

  return next;
}
