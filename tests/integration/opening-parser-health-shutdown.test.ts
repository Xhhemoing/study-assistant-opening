import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { createOpeningParserHealthRepository, createSqlClient } from "@aistudy/database";

it("cancels a blocked report connection before retirement; no late renewal can revive it", async () => {
  const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? "", process.env.OPENING_TEST_DB).toString();
  const sql = createSqlClient(url), reports = createSqlClient(url, { max: 1 });
  const id = randomUUID(), health = createOpeningParserHealthRepository(reports);
  const report = { status: "ready" as const, directoryConfigured: true, directoryExists: true, missingFiles: [], inferenceMs: 1 };
  let release!: () => void, locked!: () => void;
  const holding = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  let lock: Promise<unknown> | undefined;
  try {
    await health.record(id, report);
    const [{ pid }] = await reports`SELECT pg_backend_pid() AS pid`;
    lock = sql.begin(async tx => {
      await tx`SELECT worker_id FROM opening_parser_health WHERE worker_id=${id} FOR UPDATE`;
      locked(); await holding;
    });
    await acquired;
    const renewal = health.record(id, report);
    const rejected = expect(renewal).rejects.toThrow();
    await expect.poll(async () => {
      const [state] = await sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${pid}`;
      return state?.wait_event_type;
    }, { timeout: 5000 }).toBe("Lock");
    // Same separate connection used by production shutdown. end destroys pending
    // work after this deadline; it is not Promise.race around an uncancelled SQL write.
    await reports.end({ timeout: 0.1 });
    await rejected;
    release(); await lock;
    await createOpeningParserHealthRepository(sql).retire(id);
    await expect(health.record(id, report)).rejects.toThrow();
    const [row] = await sql`SELECT expires_at<=now() AS retired FROM opening_parser_health WHERE worker_id=${id}`;
    expect(row?.retired).toBe(true);
  } finally {
    release?.(); await lock;
    await reports.end({ timeout: 0.1 });
    await sql`DELETE FROM opening_parser_health WHERE worker_id=${id}`;
    await sql.end({ timeout: 1 });
  }
});
