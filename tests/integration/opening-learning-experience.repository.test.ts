import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, it } from "vitest";
import { recordOpeningLearningExperience, readOpeningLoopMetrics } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
const now = new Date("2026-10-21T08:00:00Z");
it("counts a shown/started pair once per local day and refuses foreign targets", async () => {
  const rows = backupRows(f.sql, f.scope), conversation = await rows.conversation();
  const input = { targetType: "conversation", targetId: conversation } as const;
  expect(await recordOpeningLearningExperience(f.sql, f.scope, { ...input, kind: "next_step_started" }, now)).toEqual({ recorded: false });
  for (let i = 0; i < 2; i++) {
    await recordOpeningLearningExperience(f.sql, f.scope, { ...input, kind: "next_step_shown" }, now);
    await recordOpeningLearningExperience(f.sql, f.scope, { ...input, kind: "next_step_started" }, new Date(now.getTime() + 1));
  }
  await expect(recordOpeningLearningExperience(f.sql, f.otherScope, { ...input, kind: "next_step_shown" }, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const report = await readOpeningLoopMetrics(f.sql, f.scope, { now: new Date(now.getTime() + 1000) });
  expect(report.groups.burden.find(metric => metric.id === "experience.next_step_started")).toMatchObject({ value: 1, numerator: 1, denominator: 1 });
  expect(report.groups.runtime.find(metric => metric.id === "experience.first_text")).toMatchObject({ value: null, dataStatus: "not_collected" });
});
it("binds first displayed text timing to its real job and submitted client key, without duplicating retries", async () => {
  const rows = backupRows(f.sql, f.scope), conversation = await rows.conversation();
  const user = await rows.turn(conversation, []), assistant = await rows.turn(conversation, []), job = randomUUID(), clientKey = randomUUID();
  await f.sql`UPDATE opening_turns SET role='user',client_key=${clientKey} WHERE id=${user}`;
  await f.sql`INSERT INTO opening_tutor_jobs(id,workspace_id,conversation_id,user_turn_id,assistant_turn_id,status,mode)
    VALUES(${job},${f.scope.workspaceId},${conversation},${user},${assistant},'running','explain')`;
  const input = { kind: "first_text", jobId: job, clientKey, durationMs: 2001 } as const;
  await expect(recordOpeningLearningExperience(f.sql, f.scope, { ...input, clientKey: "unrelated" }, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(recordOpeningLearningExperience(f.sql, f.otherScope, input, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await recordOpeningLearningExperience(f.sql, f.scope, input, now);
  await recordOpeningLearningExperience(f.sql, f.scope, { ...input, durationMs: 999 }, now);
  const report = await readOpeningLoopMetrics(f.sql, f.scope, { now: new Date(now.getTime() + 1000) });
  expect(report.groups.runtime.find(metric => metric.id === "experience.first_text")).toMatchObject({ value: 2001, sampleSize: 1, unit: "milliseconds" });
  const [stored] = await f.sql`SELECT * FROM opening_learning_experience_events WHERE target_id=${job}`;
  expect(stored).not.toHaveProperty("client_key"); expect(stored).not.toHaveProperty("text");
});
