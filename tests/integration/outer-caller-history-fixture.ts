import type { Sql, TransactionSql } from "postgres";
import { expect } from "vitest";

export function signal() {
  let resolve!: () => void;
  const ready = new Promise<void>(done => { resolve = done; });
  return { ready, resolve };
}

/** Execute every statement on PG; only pause/inject a later SQL failure after it. */
export function observeTransaction(sql: Sql, after: (query: string, tx: TransactionSql) => Promise<void>): Sql {
  return new Proxy(sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (callback: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => callback(new Proxy(tx, {
      apply(targetTx, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
        // sql(ids) and sql`` fragments must remain native Builders/PendingQueries.
        if (!Array.isArray(args[0]) || !("raw" in args[0])) return Reflect.apply(targetTx, thisArg, args);
        const query = args[0].join("?").replace(/\s+/g, " ").trim();
        const pending = Reflect.apply(targetTx, thisArg, args);
        return new Proxy(pending, { get(targetQuery, property) {
          if (property !== "then") return Reflect.get(targetQuery, property);
          return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
            targetQuery.then(async (rows: unknown) => { await after(query, tx); return rows; }).then(resolve, reject);
        } });
      },
    })));
  } });
}

/** Require an actual ungranted lock and blocking PID, not elapsed time. */
export async function assertHistoryWait(sql: Sql, writer: number, holder: number, finished: () => boolean) {
  const deadline = Date.now() + 1800;
  do {
    const [wait] = await sql`SELECT query FROM pg_stat_activity WHERE pid=${writer}
      AND ${holder}=ANY(pg_blocking_pids(pid))
      AND EXISTS(SELECT 1 FROM pg_locks WHERE pid=${writer} AND NOT granted)`;
    if (wait) {
      expect(wait.query).toContain("opening_workspace_history_revisions");
      const locks = await sql`SELECT c.relname,l.mode FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
        WHERE l.pid=${writer} AND l.granted AND l.locktype='relation' AND c.relkind='r'
          AND l.mode IN ('RowShareLock','RowExclusiveLock')`;
      expect(locks.length).toBeGreaterThan(0);
      expect(locks.every(row => row.relname === "opening_workspace_history_revisions")).toBe(true);
      console.info("outer caller history barrier", { query: wait.query, locks, blockingPids: true, ungranted: true });
      return;
    }
  } while (!finished() && Date.now() < deadline);
  throw new Error("outer caller did not block on history before business locks");
}
