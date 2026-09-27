import { assertOpeningTestDatabase } from "@aistudy/config";
import { createSqlClient } from "@aistudy/database";
import type { Sql } from "postgres";
import { vi } from "vitest";

/** Lock waiters fail inside this window. Polling stays shorter than the lock. */
const LOCK_MS = 8_000;
const POLL_MS = 5_000;
const SESSION_IDLE_MS = 20_000;

export type RaceSession = { sql: Sql; pid: number };
export type RowHold = { release: () => void; opened: Promise<void>; done: Promise<void> };

function quoteMs(ms: number): string {
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`invalid timeout ${ms}`);
  return `'${ms}ms'`;
}

/** Loopback aistudy_opening_test only. max:1 keeps one backend PID per session. */
export function openRaceSession(): RaceSession & { ready: Promise<RaceSession> } {
  const url = assertOpeningTestDatabase(
    process.env.OPENING_TEST_DATABASE_URL ?? "",
    process.env.OPENING_TEST_DB,
  );
  const sql = createSqlClient(url.toString(), { max: 1 });
  const session = { sql, pid: 0 };
  const ready = (async () => {
    const rows = await sql<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
    const row = rows[0];
    if (!row) throw new Error("race session pid missing");
    session.pid = row.pid;
    await sql.unsafe(
      `SET lock_timeout = ${quoteMs(LOCK_MS)}; SET statement_timeout = ${quoteMs(LOCK_MS)}; SET idle_in_transaction_session_timeout = ${quoteMs(SESSION_IDLE_MS)}`,
    );
    return session;
  })().catch(async (error: unknown) => {
    await sql.end({ timeout: 5 });
    throw error;
  });
  ready.then(() => undefined, () => undefined);
  return Object.assign(session, { ready });
}

export async function closeRace(sql: Sql | undefined): Promise<void> {
  if (!sql) return;
  await sql.end({ timeout: 5 });
}

/** Bounded row lock. Caller must release() then await done(); SQL timeouts bound a stuck acquire. */
export function holdRow(
  sql: Sql,
  table: "opening_memories" | "opening_turns",
  id: string,
): RowHold {
  let release: () => void = () => undefined;
  // Retain an early release if acquiring the row takes longer than opened's deadline.
  const unlocked = new Promise<void>((resolve) => { release = resolve; });
  let settleOpen: (error?: Error) => void = () => undefined;
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gate open timed out for ${table}`)), POLL_MS);
    settleOpen = (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
  });
  const done = sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL lock_timeout = ${quoteMs(LOCK_MS)}`);
    await tx.unsafe(`SET LOCAL statement_timeout = ${quoteMs(LOCK_MS)}`);
    if (table === "opening_memories") {
      await tx`SELECT id FROM opening_memories WHERE id = ${id} FOR UPDATE`;
    } else {
      await tx`SELECT id FROM opening_turns WHERE id = ${id} FOR UPDATE`;
    }
    settleOpen();
    await unlocked;
  });
  done.then(() => undefined, (error: unknown) => {
    settleOpen(error instanceof Error ? error : new Error(String(error)));
  });
  return { release: () => release(), opened, done };
}
export function track<T>(work: Promise<T>): Promise<T> {
  const tracked = work.then((value) => value);
  tracked.catch(() => undefined);
  return tracked;
}

/** True overlap: waiterPid is currently blocked by blockerPid. Not elapsed-time. */
export async function waitUntilBlocked(
  observer: Sql,
  waiterPid: number,
  blockerPid: number,
  label: string,
  statementPattern?: RegExp,
): Promise<void> {
  await vi.waitFor(async () => {
    const rows = await observer<{ blocked: number }[]>`
      SELECT count(*)::int AS blocked FROM pg_locks
      WHERE pid = ${waiterPid} AND NOT granted
        AND ${blockerPid} = ANY(pg_blocking_pids(pid))
    `;
    expectBlocked(rows[0]?.blocked ?? 0, label);
    if (statementPattern) {
      const activity = await observer<{ query: string }[]>`
        SELECT query FROM pg_stat_activity WHERE pid = ${waiterPid}
      `;
      if (!statementPattern.test(activity[0]?.query ?? "")) {
        throw new Error(`${label} blocked on unexpected statement: ${activity[0]?.query}`);
      }
    }
  }, { timeout: POLL_MS, interval: 40 });
}

function expectBlocked(count: number, label: string): void {
  if (count < 1) throw new Error(`${label} not blocked yet`);
}

export async function awaitAllSettled(pending: Promise<unknown>[]): Promise<void> {
  await Promise.allSettled(pending);
}
