import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activitySpecSchema } from "@aistudy/contracts";
import { createLibraryRepository, createOpeningTeachingActivitiesRepository, createOpeningTeachingContentRepository } from "@aistudy/database";
import { POST as createSession } from "../../../apps/web/src/app/api/opening/learning-sessions/route";
import { POST as createAttempt } from "../../../apps/web/src/app/api/opening/attempts/route";
import { POST as submitAttempt } from "../../../apps/web/src/app/api/opening/attempts/[id]/submit/route";
import { GET as answerKey } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/answer-key/route";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { POST } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/reference-revision/route";
import { GET as init } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/client-init/route";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";

let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (body: unknown, cookie = f.cookie) => new Request("https://localhost/api/opening/teaching-activities/reference-revision", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret", sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
afterAll(async () => {
  setAuthRuntimeForTests(null); await runtime?.close();
  if (f) {
    await f.sql`TRUNCATE opening_learning_sessions,opening_teaching_activity_specs,opening_teaching_units,opening_teaching_activities,library_blocks,library_revisions,library_documents CASCADE`;
    await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`; await f.close();
  }
});
async function seed() {
  const repo = createOpeningTeachingContentRepository(f.sql);
  const activity = await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, { clientKey: randomUUID(), intentKind: "topic", intentSummary: "参考修订", createIntent: {} });
  const blocks = [
    { id: randomUUID(), type: "prompt", content: { text: "计算 2+3" } },
    { id: randomUUID(), type: "answer_key", content: { text: "4", citedChunkIds: [] } },
    { id: randomUUID(), type: "text", content: { text: "未选中的内容" } },
  ];
  const unit = await repo.createUnit(f.scope, { title: "修订", blocks });
  const spec = await repo.publishActivitySpec(f.scope, { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: 0, revisionNumber: 1,
    blockOrder: blocks.slice(0, 2).map((b, position) => ({ blockId: b.id, blockType: b.type, position, role: position ? "answer_key" as const : "prompt" as const })) });
  const edited = structuredClone(blocks); edited[1]!.content.text = "5";
  const save = (next = edited, expectedRevisionNumber = 1) => createLibraryRepository(f.sql).updateDocument({ workspaceId: f.scope.workspaceId, documentId: unit.documentId, expectedRevisionNumber, blocks: next });
  return { repo, activity, unit, spec, blocks, edited, save, input: { expectedContentVersion: 1, expectedRevisionNumber: 1, revisionNumber: 2 } };
}
describe("explicit saved reference revision", () => {
  async function snapshot() {
    const tables = ["opening_teaching_activity_specs", "opening_teaching_units", "opening_teaching_activities", "library_revisions", "opening_learning_attempts", "opening_learning_observations", "opening_jobs", "opening_outbox", "opening_budget_reservations"];
    return Promise.all(tables.map(table => f.sql.unsafe(`SELECT row_to_json(t)::text AS bytes FROM ${table} t ORDER BY row_to_json(t)::text`)));
  }
  it.each(["prompt", "type", "order", "citation", "hidden", "empty", "incorrect", "unchanged", "old-version", "old-pin", "missing", "verified", "completed", "queued", "generating", "anonymous", "foreign"])("rejects %s without writes", async kind => {
    const s = await seed();
    const edited = structuredClone(s.edited);
    if (kind === "prompt") edited[0]!.content.text = "计算 3+3";
    if (kind === "type") edited[1]!.type = "solution";
    if (kind === "order") edited.reverse();
    if (kind === "citation") Object.assign(edited[1]!.content, { citedChunkIds: [randomUUID()] });
    if (kind === "hidden") edited[2]!.content.text = "偷改";
    if (kind === "empty") edited[1]!.content.text = " ";
    if (kind === "incorrect") edited[1]!.content.text = "6";
    await s.save(kind === "unchanged" ? s.blocks : edited);
    if (["completed", "queued", "generating"].includes(kind)) {
      if (kind === "completed") await f.sql`UPDATE opening_teaching_activities SET status='completed' WHERE id=${s.activity.id}`;
      else await f.sql`UPDATE opening_teaching_activities SET generate_status=${kind} WHERE id=${s.activity.id}`;
    }
    const input = { ...s.input, ...(kind === "old-version" ? { expectedContentVersion: 3 } : {}), ...(kind === "old-pin" ? { expectedRevisionNumber: 2 } : {}), ...(kind === "missing" ? { revisionNumber: 99 } : {}), ...(kind === "verified" ? { verificationStatus: "verified" } : {}) };
    const id = kind === "foreign" ? (await createOpeningTeachingActivitiesRepository(f.sql).create(f.otherScope, { clientKey: randomUUID(), intentKind: "topic", intentSummary: "other", createIntent: {} })).id : s.activity.id;
    const before = await snapshot();
    const response = await POST(request(input, kind === "anonymous" ? "" : f.cookie), context(id));
    expect(response.status).toBe(kind === "anonymous" ? 401 : kind === "foreign" ? 404 : ["old-version", "old-pin", "missing", "completed", "queued", "generating"].includes(kind) ? 409 : 400);
    expect(await snapshot()).toEqual(before);
  });
  it("rejects a newer competing save and accepts multiple saved revisions only at latest", async () => {
    const s = await seed(); await s.save();
    const next = structuredClone(s.edited); next[1]!.content.text = "5.0";
    await s.save(next, 2);
    expect((await POST(request(s.input), context(s.activity.id))).status).toBe(409);
    const input = { ...s.input, revisionNumber: 3 };
    expect((await POST(request(input), context(s.activity.id))).status).toBe(200);
    expect((await POST(request({ ...input, expectedRevisionNumber: 2 }), context(s.activity.id))).status).toBe(409);
    await s.save(next, 3);
    expect((await POST(request(input), context(s.activity.id))).status).toBe(409);
  });
  it("preserves submitted history and refuses to unlock the new answer with an old attempt", async () => {
    const s = await seed();
    // Unsupported proof text remains manually reviewable, never automatically verified.
    const proof = structuredClone(s.blocks).map(b => ({ ...b, id: randomUUID() })); proof[0]!.content.text = "证明三角形内角和";
    const unit = await s.repo.createUnit(f.scope, { title: "证明", blocks: proof });
    await s.repo.publishActivitySpec(f.scope, { activityId: s.activity.id, teachingUnitId: unit.id, expectedVersion: 1, revisionNumber: 1,
      blockOrder: s.spec.blockOrder.map((b, index) => ({ ...b, blockId: proof[index]!.id })) });
    const courseId = randomUUID();
    await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES (${courseId},${f.scope.workspaceId},'证明',${courseId})`;
    await f.sql`UPDATE opening_teaching_activities SET course_id=${courseId} WHERE id=${s.activity.id}`;
    const sessionResponse = await createSession(request({ activityId: s.activity.id, courseId, skillLabel: "证明", sourceIds: [] }));
    expect(sessionResponse.status).toBe(201); const session = await sessionResponse.json();
    const attemptResponse = await createAttempt(request({ sessionId: session.id, clientKey: randomUUID(), teachingBlock: { blockId: proof[0]!.id, contentVersion: 2 } }));
    expect(attemptResponse.status).toBe(201); const attempt = await attemptResponse.json();
    expect((await submitAttempt(request({ clientKey: randomUUID(), answer: "我的证明", outcome: "unverified", assistance: "independent", verdictSource: "self_report" }), context(attempt.id))).status).toBe(201);
    const history = async () => Promise.all([
      f.sql`SELECT row_to_json(t)::text AS bytes FROM opening_learning_attempts t WHERE id=${attempt.id}`,
      f.sql`SELECT row_to_json(t)::text AS bytes FROM opening_learning_observations t WHERE attempt_id=${attempt.id}`,
      f.sql`SELECT row_to_json(t)::text AS bytes FROM opening_jobs t ORDER BY id`,
      f.sql`SELECT row_to_json(t)::text AS bytes FROM opening_outbox t ORDER BY id`,
      f.sql`SELECT row_to_json(t)::text AS bytes FROM opening_budget_reservations t ORDER BY id`,
    ]);
    const before = await history();
    const edited = structuredClone(proof); edited[1]!.content.text = "由平行线同位角得到内角和180度";
    await createLibraryRepository(f.sql).updateDocument({ workspaceId: f.scope.workspaceId, documentId: unit.documentId, expectedRevisionNumber: 1, blocks: edited });
    expect((await POST(request({ expectedContentVersion: 2, expectedRevisionNumber: 1, revisionNumber: 2 }), context(s.activity.id))).status).toBe(200);
    const url = `https://localhost?blockId=${proof[0]!.id}&attemptId=${attempt.id}`;
    expect((await answerKey(new Request(url, { headers: { cookie: f.cookie } }), context(s.activity.id))).status).toBe(409);
    expect(await history()).toEqual(before);
    expect((await s.repo.readRevision(f.scope, unit.documentId, 1)).blocks.map(b => b.content)).toEqual(proof.map(b => b.content));
  });
  it("publishes only on explicit adoption, redacts the new answer, and replays without bumping", async () => {
    const s = await seed(); await s.save();
    expect((await s.repo.getClientInit(f.scope, s.activity.id))?.revisionNumber).toBe(1);
    const response = await POST(request(s.input), context(s.activity.id));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const spec = activitySpecSchema.parse(await response.json());
    expect(spec).toMatchObject({ version: 2, revisionNumber: 2, verificationStatus: "needs_check", blockOrder: s.spec.blockOrder, sourceRefs: s.spec.sourceRefs, generationConfig: s.spec.generationConfig });
    const read = await init(new Request("https://localhost", { headers: { cookie: f.cookie } }), context(s.activity.id));
    expect(await read.json()).toMatchObject({ contentVersion: 2, revisionNumber: 2, blocks: [{ content: { text: "计算 2+3" } }, { content: null, answerRef: { revealState: "hidden" } }] });
    expect(activitySpecSchema.parse(await (await POST(request(s.input), context(s.activity.id))).json())).toEqual(spec);
    expect((await s.repo.readRevision(f.scope, s.unit.documentId, 1)).blocks.map(b => b.content)).toEqual(s.blocks.map(b => b.content));
  });
});
