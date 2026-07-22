import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spikeEvents } from "./schema";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://aistudy:aistudy@127.0.0.1:5432/aistudy_spike";

describe("PostgreSQL + Drizzle JSONB transaction isolation", () => {
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  beforeAll(async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS spike_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind text NOT NULL,
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });

  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  it("commits JSONB payload inside a transaction and rolls back isolated writes", async () => {
    const committedKind = `committed-${Date.now()}`;

    await db.transaction(async (tx) => {
      await tx.insert(spikeEvents).values({
        kind: committedKind,
        payload: { score: 0.8, tags: ["spike", "jsonb"] },
      });
    });

    const committed = await db
      .select()
      .from(spikeEvents)
      .where(sql`${spikeEvents.kind} = ${committedKind}`);

    expect(committed).toHaveLength(1);
    expect(committed[0]?.payload).toEqual({
      score: 0.8,
      tags: ["spike", "jsonb"],
    });

    const rolledBackKind = `rolled-back-${Date.now()}`;

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(spikeEvents).values({
          kind: rolledBackKind,
          payload: { should: "not-persist" },
        });
        throw new Error("force-rollback");
      }),
    ).rejects.toThrow("force-rollback");

    const rolledBack = await db
      .select()
      .from(spikeEvents)
      .where(sql`${spikeEvents.kind} = ${rolledBackKind}`);

    expect(rolledBack).toHaveLength(0);
  });
});
