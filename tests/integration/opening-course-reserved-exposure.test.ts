import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readCourseQuestionExposure, recordCourseQuestionExposure } from "../../packages/database/src/repositories/opening-course-question-exposure";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const question = () => ({ reservedQuestionId: randomUUID(), identityRefId: randomUUID(), courseId: randomUUID(),
  requirementId: randomUUID(), requirementRevision: 1, sourceVersions: {}, text: "137*19",
  interaction: { kind: "numeric" as const }, familyId: "arithmetic:*" });
it("does not accept a caller-seeded complete row or an empty ledger as historical coverage", async () => {
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "unknown" });
  await f.sql`INSERT INTO opening_course_question_exposure_coverage(workspace_id,owner_user_id,protocol,history_revision,complete,covered_surface_count)
    VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},'course-question-exposure-1',0,true,0)`;
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "unknown" });
});
it("persists a presentation before answer, keeps replay idempotent and rolls back failed writes", async () => {
  const input = { surfaceKey: "presented:question", kind: "presented" as const, text: "137*19", sourceVersions: {} };
  await Promise.all([1, 2].map(() => f.sql.begin(tx => recordCourseQuestionExposure(tx, f.scope, input))));
  const rows = await f.sql`SELECT kind,exact_content FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "presented", exact_content: { complete: true, expressions: ["137*19"], families: ["arithmetic:*"] } });
  await expect(f.sql.begin(async tx => {
    await recordCourseQuestionExposure(tx, f.scope, { ...input, surfaceKey: "failed", kind: "hint" });
    throw new Error("presentation failed");
  })).rejects.toThrow("presentation failed");
  expect(await f.sql`SELECT id FROM opening_course_question_exposures WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  expect(await readCourseQuestionExposure(f.sql, f.scope, question())).toMatchObject({ coverage: "unknown" });
});
