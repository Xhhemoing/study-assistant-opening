import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createOpeningBudgetRepository,
  createOpeningJobRepository,
  createOpeningSourceRepository,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const uploadInput = {
  name: "a.pdf",
  mime: "application/pdf" as const,
  bytes: 12,
  sha256: "a".repeat(64),
};

let fixture: OpeningFixture;
let sources: ReturnType<typeof createOpeningSourceRepository>;
let jobs: ReturnType<typeof createOpeningJobRepository>;
let budget: ReturnType<typeof createOpeningBudgetRepository>;

beforeAll(async () => {
  fixture = await createOpeningFixture();
  sources = createOpeningSourceRepository(fixture.sql);
  jobs = createOpeningJobRepository(fixture.sql);
  budget = createOpeningBudgetRepository(fixture.sql, { dailyCapCents: 100_000 });
});
beforeEach(async () => {
  await fixture.reset();
});
afterAll(async () => {
  await fixture?.close();
});

describe("opening foundation", () => {
  it("never reads another workspace source", async () => {
    const record = await sources.create(fixture.scope, uploadInput);
    await expect(
      sources.get(fixture.otherScope, record.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("createOnce returns the original and rejects a changed payload", async () => {
    const first = await jobs.createOnce(fixture.scope, {
      key: "source-1",
      kind: "parse",
      payload: { sourceId: "s" },
      privacyEpoch: 0,
    });
    const replay = await jobs.createOnce(fixture.scope, {
      key: "source-1",
      kind: "parse",
      payload: { sourceId: "s" },
      privacyEpoch: 0,
    });
    expect(replay.id).toBe(first.id);
    await expect(
      jobs.createOnce(fixture.scope, {
        key: "source-1",
        kind: "parse",
        payload: { sourceId: "other" },
        privacyEpoch: 0,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const rows = await fixture.sql`SELECT count(*)::int AS count FROM opening_jobs`;
    expect(rows[0].count).toBe(1);
  });

  it("enforces the workspace budget and request idempotency", async () => {
    const first = await budget.reserve(fixture.scope, {
      purpose: "parse",
      amountCents: 60_000,
      requestId: "r1",
    });
    const replay = await budget.reserve(fixture.scope, {
      purpose: "parse",
      amountCents: 60_000,
      requestId: "r1",
    });
    expect(replay.id).toBe(first.id);
    await expect(
      budget.reserve(fixture.scope, {
        purpose: "tutor",
        amountCents: 40_001,
        requestId: "r2",
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("retains an unknown external outcome reservation", async () => {
    await budget.reserve(fixture.scope, {
      purpose: "tutor",
      amountCents: 10,
      requestId: "unknown",
    });
    const rows = await fixture.sql`
      SELECT state FROM opening_budget_reservations WHERE request_id = 'unknown'
    `;
    expect(rows[0].state).toBe("reserved");
  });

  it("keeps source upload state independent from parse job state", async () => {
    const source = await sources.create(fixture.scope, uploadInput);
    const job = await jobs.createOnce(fixture.scope, {
      key: "parse-1",
      kind: "parse",
      payload: { sourceId: source.id },
      privacyEpoch: 0,
    });
    expect((await sources.get(fixture.scope, source.id)).uploadState).toBe("pending");
    expect(job.state).toBe("queued");
  });

  it("commits source, job, and outbox atomically and rolls back on failure", async () => {
    const created = await sources.createWithParseJob(fixture.scope, {
      source: uploadInput,
      key: "parse-atomic",
      payload: { sourceId: "pending" },
      privacyEpoch: 0,
    });
    const rows = await fixture.sql`
      SELECT
        (SELECT count(*) FROM opening_sources) AS sources,
        (SELECT count(*) FROM opening_jobs) AS jobs,
        (SELECT count(*) FROM opening_outbox) AS outbox
    `;
    expect(Number(rows[0].sources)).toBe(1);
    expect(Number(rows[0].jobs)).toBe(1);
    expect(Number(rows[0].outbox)).toBe(1);
    expect(created.job.state).toBe("queued");
    await expect(
      sources.createWithParseJob(fixture.scope, {
        source: uploadInput,
        key: "parse-bad",
        kind: "invalid",
        payload: {},
        privacyEpoch: 0,
      }),
    ).rejects.toThrow();
    const after = await fixture.sql`
      SELECT count(*) FROM opening_sources WHERE name = ${uploadInput.name}
    `;
    expect(Number(after[0].count)).toBe(1);
  });
});
