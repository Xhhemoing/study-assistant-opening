import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readOpeningBackupRecords } from "@aistudy/database";
import { createOpeningFixture, insertTestTeachingActivity, type OpeningFixture } from "./opening-fixture";

// Storage-boundary tests only. Raw rows are deliberately NOT trusted candidate
// admission, exposure-coverage evidence, ready eligibility or issuance evidence.
let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });

async function setup() {
  const courseId = randomUUID(), requirementId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug)
    VALUES(${courseId},${f.scope.workspaceId},'Private supply',${courseId})`;
  await f.sql`INSERT INTO course_requirements(id,workspace_id,owner_user_id,course_id,stable_skill_id,requirement_key,title,verification)
    VALUES(${requirementId},${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},${randomUUID()},'addition','Addition','{}')`;
  const activityId = await insertTestTeachingActivity(f.sql, f.scope, courseId);
  return { courseId, requirementId, activityId };
}
async function insert(x: Awaited<ReturnType<typeof setup>>, workspaceId = f.scope.workspaceId) {
  const id = randomUUID(), keyId = randomUUID(), sourceId = randomUUID();
  // This shape fixture intentionally claims no existing source or publication.
  // A storage row is not a verified question: future admission must resolve refs.
  const identity = { identityRefId: id };
  const key = { keyRefId: keyId, identity, answer: "private-key-fixture" };
  await f.sql`INSERT INTO opening_course_reserved_questions(id,workspace_id,owner_user_id,course_id,requirement_id,requirement_revision,
    source_versions,identity_ref_id,identity_json,family_id,content_ref_id,key_ref_id,question_json,interaction_json,key_json)
    VALUES(${id},${workspaceId},${f.scope.ownerUserId},${x.courseId},${x.requirementId},1,
      ${f.sql.json({ [sourceId]: 1 })},${id},${f.sql.json(identity)},'fixture-family',${randomUUID()},${keyId},
      ${f.sql.json({ text: "private-prompt-fixture" })},${f.sql.json({ kind: "numeric" })},${f.sql.json(key)})`;
  return id;
}
it("creates only private supply and enforces same-workspace course/requirement foreign keys", async () => {
  const x = await setup(), id = await insert(x);
  const [row] = await f.sql`SELECT state,reserved_at,issued_at FROM opening_course_reserved_questions WHERE id=${id}`;
  expect(row).toMatchObject({ state: "available", reserved_at: null, issued_at: null });
  await expect(insert(x, f.otherScope.workspaceId)).rejects.toMatchObject({ code: "23503" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET requirement_id=${randomUUID()} WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23503" });
});
it("rejects incomplete reservation/issuance, wrong key identity and empty source snapshots", async () => {
  const x = await setup(), id = await insert(x);
  await expect(f.sql`UPDATE opening_course_reserved_questions SET state='reserved' WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET reserved_at=now(),reservation_key=${randomUUID()} WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET state='issued',issued_at=now() WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET state='revoked' WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET key_ref_id=${randomUUID()} WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET identity_json='{}' WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
  await expect(f.sql`UPDATE opening_course_reserved_questions SET source_versions='{}' WHERE id=${id}`)
    .rejects.toMatchObject({ code: "23514" });
});
it("rolls back a failed reservation transaction without discarding immutable private content", async () => {
  const x = await setup(), id = await insert(x);
  await expect(f.sql.begin(async tx => {
    await tx`UPDATE opening_course_reserved_questions SET state='reserved',reservation_key=${randomUUID()},
      reserved_activity_id=${x.activityId},reserved_at=now() WHERE id=${id}`;
    throw new Error("consumer failed");
  })).rejects.toThrow("consumer failed");
  const [row] = await f.sql`SELECT state,reservation_key,reserved_activity_id,reserved_at,question_json,key_json
    FROM opening_course_reserved_questions WHERE id=${id}`;
  expect(row).toMatchObject({ state: "available", reservation_key: null, reserved_activity_id: null, reserved_at: null,
    question_json: { text: "private-prompt-fixture" }, key_json: { answer: "private-key-fixture" } });
});
it("does not include the new private table in the ordinary client backup", async () => {
  const x = await setup(); await insert(x);
  const backup = await readOpeningBackupRecords(f.sql, f.scope);
  const serialized = JSON.stringify(backup);
  expect(serialized).not.toContain("private-prompt-fixture");
  expect(serialized).not.toContain("private-key-fixture");
  expect(serialized).not.toContain("opening_course_reserved_questions");
});
