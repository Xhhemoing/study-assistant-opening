import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sourceRecordSchema } from "@aistudy/contracts";
import { OpeningProviderError, runBudgetedCall } from "@aistudy/ai";
import { createOpeningBudgetRepository, createOpeningJobRepository, createOpeningSourceRepository } from "@aistudy/database";
import { runJob } from "../../apps/worker/src/runtime/run-job";
import { scopeBudget } from "../../apps/worker/src/runtime/model-gateway";
import { MediaValidationError } from "../../apps/worker/src/parsers/media-process";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`UPDATE workspaces SET privacy_epoch = 0 WHERE id = ${fixture.scope.workspaceId}`;
});
afterAll(async () => { await fixture?.close(); });

async function seed(kind: "parse" | "parse-media" = "parse") {
  const sourceId = randomUUID();
  await fixture.sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'broken.pdf', 'application/pdf', 44, ${"a".repeat(64)}, 0, 'uploaded', 'not_started')`;
  const repository = createOpeningJobRepository(fixture.sql);
  const job = await repository.createOnce(fixture.scope, {
    key: randomUUID(), kind, payload: { sourceId, sourceVersion: 0 }, privacyEpoch: 0,
  });
  return { sourceId, job, repository, sources: createOpeningSourceRepository(fixture.sql) };
}

describe("parse failure source projection", () => {
  it("atomically finishes the failed job and exposes a safe source failure while retaining the original", async () => {
    const { sourceId, job, repository, sources } = await seed();
    expect(await runJob(repository, job.id, async () => { throw new Error("private parser path or source text"); })).toBe(true);
    expect((await repository.get(fixture.scope, job.id)).state).toBe("failed");
    const record = sourceRecordSchema.parse(await sources.get(fixture.scope, sourceId));
    expect(record).toMatchObject({ uploadState: "uploaded", parseState: "failed", version: 0,
      error: { code: "PARSE_FAILED", message: "材料解析失败，原件仍已保存。", retryable: true } });
    expect(JSON.stringify(record.error)).not.toContain("private parser");
    expect(await runJob(repository, job.id, async () => { throw new Error("redelivery ran"); })).toBe(false);
    expect(await repository.finish(job.id, "failed", { error: "redelivery" })).toBe(false);
    expect(await sources.get(fixture.scope, sourceId)).toEqual(record);
  });

  it("allows a recoverable media failure to enter the manual retry path", async () => {
    const { sourceId, job, repository, sources } = await seed("parse-media");
    await runJob(repository, job.id, async () => { throw new Error("third conversion interrupted"); });
    expect(await sources.get(fixture.scope, sourceId)).toMatchObject({ parseState: "failed", error: { retryable: true } });
    await sources.retryParseWithJob(fixture.scope, sourceId, {
      key: randomUUID(), payload: { sourceId, sourceVersion: 0 }, privacyEpoch: 0,
    });
    expect((await sources.get(fixture.scope, sourceId)).parseState).toBe("queued");
  });

  it("keeps invalid media failures non-retryable", async () => {
    const { sourceId, job, repository, sources } = await seed("parse-media");
    await runJob(repository, job.id, async () => { throw new MediaValidationError("invalid input"); });
    expect(await sources.get(fixture.scope, sourceId)).toMatchObject({ parseState: "failed", error: { retryable: false } });
  });

  it.each(["PROVIDER_TIMEOUT", "PROVIDER_NETWORK"])("ends the source spinner after %s without releasing or resending the unknown call", async code => {
    const { sourceId, job, repository, sources } = await seed("parse-media");
    const budget = createOpeningBudgetRepository(fixture.sql, { envCapCents: 100_000 });
    let calls = 0;
    const handler = async () => runBudgetedCall({
      budget: scopeBudget(budget, fixture.scope), provider: { complete: async () => { calls += 1; throw new OpeningProviderError(code, "provider response lost", true); } },
      requestId: `transcribe:${job.id}:0`, purpose: "transcribe", reservedCents: 100, actualCents: () => 1,
      input: { instruction: "transcribe", text: "audio", chunks: [], mode: "listen", maxOutputTokens: 100, mediaCapability: "text_only", imageParts: [] },
    });
    expect(await runJob(repository, job.id, handler)).toBe(true);
    expect((await repository.get(fixture.scope, job.id)).state).toBe("outcome_unknown");
    expect(await sources.get(fixture.scope, sourceId)).toMatchObject({ uploadState: "uploaded", parseState: "failed",
      error: { code: "PARSE_OUTCOME_UNKNOWN", retryable: false } });
    const [reservation] = await fixture.sql`SELECT state, outcome_unknown_at FROM opening_budget_reservations WHERE workspace_id=${fixture.scope.workspaceId}`;
    expect(reservation).toMatchObject({ state: "reserved", outcome_unknown_at: expect.any(Date) });
    expect(await runJob(repository, job.id, handler)).toBe(false);
    expect(calls).toBe(1);
  });

  for (const change of ["version", "epoch", "ready", "unsupported", "excluded", "foreign workspace", "wrong owner"] as const) {
    it(`records job failure without overwriting a source after ${change} changes`, async () => {
      const { sourceId, job, repository, sources } = await seed();
      expect(await runJob(repository, job.id, async () => {
        if (change === "version") await fixture.sql`UPDATE opening_sources SET version = 1 WHERE id = ${sourceId}`;
        if (change === "epoch") await fixture.sql`UPDATE workspaces SET privacy_epoch = 1 WHERE id = ${fixture.scope.workspaceId}`;
        if (change === "ready" || change === "unsupported") await fixture.sql`UPDATE opening_sources SET parse_state = ${change} WHERE id = ${sourceId}`;
        if (change === "excluded") await fixture.sql`INSERT INTO opening_privacy_exclusions (workspace_id, source_id, deleted_at) VALUES (${fixture.scope.workspaceId}, ${sourceId}, now())`;
        if (change === "foreign workspace") await fixture.sql`UPDATE opening_jobs SET workspace_id = ${fixture.otherScope.workspaceId}, owner_user_id = ${fixture.otherScope.ownerUserId} WHERE id = ${job.id}`;
        if (change === "wrong owner") await fixture.sql`UPDATE opening_jobs SET owner_user_id = ${fixture.otherScope.ownerUserId} WHERE id = ${job.id}`;
        throw new Error("conversion failed");
      })).toBe(true);
      const record = await sources.get(fixture.scope, sourceId);
      if (change === "epoch") {
        // a8d7c8d: a job made stale by a privacy change is surfaced as a terminal
        // PARSE_STALE failure so the inbox does not stay pending forever.
        expect(record.parseState).toBe("failed");
        expect(record.error).toMatchObject({ code: "PARSE_STALE", retryable: false });
      } else {
        expect(record.parseState).toBe(change === "ready" || change === "unsupported" ? change : "not_started");
        expect(record.error).toBeNull();
      }
      expect((await fixture.sql`SELECT state FROM opening_jobs WHERE id = ${job.id}`)[0]?.state).toBe("failed");
    });
  }

  it("does not project failure after cancellation wins the job compare-and-set", async () => {
    const { sourceId, job, repository, sources } = await seed();
    const claimed = await repository.claim(job.id);
    await fixture.sql`UPDATE opening_jobs SET state = 'cancelled' WHERE id = ${job.id}`;
    expect(await repository.finish(job.id, "failed", { error: "late failure" }, claimed!.claimToken)).toBe(false);
    expect((await sources.get(fixture.scope, sourceId)).parseState).toBe("not_started");
    expect((await repository.get(fixture.scope, job.id)).state).toBe("cancelled");
  });

  it("waits for an in-flight privacy epoch change before projecting source failure", async () => {
    const { sourceId, job, repository, sources } = await seed();
    const claimed = await repository.claim(job.id);
    const gate = openRaceSession();
    const writer = openRaceSession();
    const observer = openRaceSession();
    let pending: Promise<boolean> | undefined;
    try {
      await Promise.all([gate.ready, writer.ready, observer.ready]);
      await gate.sql.begin(async (tx) => {
        await tx`UPDATE workspaces SET privacy_epoch = 1 WHERE id = ${fixture.scope.workspaceId}`;
        pending = track(createOpeningJobRepository(writer.sql).finish(job.id, "failed", { error: "conversion failed" }, claimed!.claimToken));
        await waitUntilBlocked(observer.sql, writer.pid, gate.pid, "parse failure", /FOR UPDATE OF w/);
      });
      expect(await pending).toBe(true);
      expect((await repository.get(fixture.scope, job.id)).state).toBe("failed");
      // The failure is projected only after the epoch change commits, so it sees
      // the job as stale and records PARSE_STALE rather than a parse failure.
      expect(await sources.get(fixture.scope, sourceId)).toMatchObject({ parseState: "failed", error: { code: "PARSE_STALE" } });
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await Promise.all([closeRace(gate.sql), closeRace(writer.sql), closeRace(observer.sql)]);
    }
  });
  it("rejects malformed source identifiers without rolling back the failed job", async () => {
    const { job, repository } = await seed();
    await fixture.sql`UPDATE opening_jobs SET payload = ${fixture.sql.json({ sourceId: "not-a-uuid" })} WHERE id = ${job.id}`;
    const claimed = await repository.claim(job.id);
    expect(await repository.finish(job.id, "failed", { error: "invalid payload" }, claimed!.claimToken)).toBe(true);
    expect((await repository.get(fixture.scope, job.id)).state).toBe("failed");
  });
});
