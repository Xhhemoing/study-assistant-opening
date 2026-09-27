import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sourceRecordSchema } from "@aistudy/contracts";
import { createOpeningJobRepository, createOpeningSourceRepository } from "@aistudy/database";
import { runJob } from "../../apps/worker/src/runtime/run-job";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.sql`UPDATE workspaces SET privacy_epoch = 0 WHERE id = ${fixture.scope.workspaceId}`;
});
afterAll(async () => { await fixture?.close(); });

async function seed() {
  const sourceId = randomUUID();
  await fixture.sql`INSERT INTO opening_sources (id, workspace_id, name, mime, bytes, sha256, version, upload_state, parse_state)
    VALUES (${sourceId}, ${fixture.scope.workspaceId}, 'broken.pdf', 'application/pdf', 44, ${"a".repeat(64)}, 0, 'uploaded', 'not_started')`;
  const repository = createOpeningJobRepository(fixture.sql);
  const job = await repository.createOnce(fixture.scope, {
    key: randomUUID(), kind: "parse", payload: { sourceId }, privacyEpoch: 0,
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
      error: { code: "PARSE_FAILED", message: "材料解析失败，原件仍已保存。", retryable: false } });
    expect(JSON.stringify(record.error)).not.toContain("private parser");
    expect(await runJob(repository, job.id, async () => { throw new Error("redelivery ran"); })).toBe(false);
    expect(await repository.finish(job.id, "failed", { error: "redelivery" })).toBe(false);
    expect(await sources.get(fixture.scope, sourceId)).toEqual(record);
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
      expect(record.parseState).toBe(change === "ready" || change === "unsupported" ? change : "not_started");
      expect(record.error).toBeNull();
      expect((await fixture.sql`SELECT state FROM opening_jobs WHERE id = ${job.id}`)[0]?.state).toBe("failed");
    });
  }

  it("does not project failure after cancellation wins the job compare-and-set", async () => {
    const { sourceId, job, repository, sources } = await seed();
    await repository.claim(job.id);
    await fixture.sql`UPDATE opening_jobs SET state = 'cancelled' WHERE id = ${job.id}`;
    expect(await repository.finish(job.id, "failed", { error: "late failure" })).toBe(false);
    expect((await sources.get(fixture.scope, sourceId)).parseState).toBe("not_started");
    expect((await repository.get(fixture.scope, job.id)).state).toBe("cancelled");
  });

  it("waits for an in-flight privacy epoch change before projecting source failure", async () => {
    const { sourceId, job, repository, sources } = await seed();
    await repository.claim(job.id);
    const gate = openRaceSession();
    const writer = openRaceSession();
    const observer = openRaceSession();
    let pending: Promise<boolean> | undefined;
    try {
      await Promise.all([gate.ready, writer.ready, observer.ready]);
      await gate.sql.begin(async (tx) => {
        await tx`UPDATE workspaces SET privacy_epoch = 1 WHERE id = ${fixture.scope.workspaceId}`;
        pending = track(createOpeningJobRepository(writer.sql).finish(job.id, "failed", { error: "conversion failed" }));
        await waitUntilBlocked(observer.sql, writer.pid, gate.pid, "parse failure", /FOR UPDATE OF w/);
      });
      expect(await pending).toBe(true);
      expect((await repository.get(fixture.scope, job.id)).state).toBe("failed");
      expect((await sources.get(fixture.scope, sourceId)).parseState).toBe("not_started");
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      await Promise.all([closeRace(gate.sql), closeRace(writer.sql), closeRace(observer.sql)]);
    }
  });
  it("rejects malformed source identifiers without rolling back the failed job", async () => {
    const { job, repository } = await seed();
    await fixture.sql`UPDATE opening_jobs SET payload = ${fixture.sql.json({ sourceId: "not-a-uuid" })} WHERE id = ${job.id}`;
    await repository.claim(job.id);
    expect(await repository.finish(job.id, "failed", { error: "invalid payload" })).toBe(true);
    expect((await repository.get(fixture.scope, job.id)).state).toBe("failed");
  });
});
