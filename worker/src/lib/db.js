import postgres from "postgres";

/* ============================================================
   Postgres on Workers

   One connection per request through Hyperdrive, which pools on
   Cloudflare's side. A Worker has no process to keep a pool in, so
   without Hyperdrive every request opens its own connection and the
   database runs out of them long before the traffic justifies it.

   Everything here is async. That is the difference that matters
   when porting: better-sqlite3 was synchronous, so the 793 calls in
   server/ all need awaiting, and every function containing one
   needs to become async. There is no shortcut around that.
   ============================================================ */

const clients = new WeakMap();

export function connect(env) {
  if (!env.DB?.connectionString)
    throw Object.assign(new Error("HYPERDRIVE_NOT_BOUND"), { status: 503,
      code: "DB_NOT_CONFIGURED" });

  return postgres(env.DB.connectionString, {
    // Hyperdrive already pools. A second pool inside the Worker would just
    // hold connections open across requests that cannot reuse them.
    max: 5,
    fetch_types: false,     // saves a round trip on every cold start
    prepare: false,         // Hyperdrive multiplexes, so named statements do not survive
  });
}

/** Closes without making the response wait. Called from waitUntil. */
export async function closeAll(c) {
  const sql = c.get?.("db");
  if (sql) await sql.end({ timeout: 5 }).catch(() => {});
}

/**
 * A transaction, which is the whole reason this system needs Postgres rather
 * than a key-value store.
 *
 * The parking allocation, the signing lock and the balanced-entry check all
 * read and write inside one, and none of them mean anything if another
 * request can slip between the read and the write.
 */
export async function txn(sql, fn) {
  return sql.begin(async (tx) => fn(tx));
}

/**
 * SELECT ... FOR UPDATE, which replaces SQLite's immediate transaction.
 *
 * Two people clicking "allocate the last stall" at the same moment is the
 * case this exists for. The first locks the row; the second waits, then reads
 * the row as it now is and finds nothing free.
 */
export async function lockRow(tx, table, column, value) {
  const [row] = await tx`
    SELECT * FROM ${tx(table)} WHERE ${tx(column)} = ${value} FOR UPDATE`;
  return row ?? null;
}
