import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOpeningTeachingActivitiesRepository, createOpeningTeachingCommandsRepository, createOpeningTeachingContentRepository } from "@aistudy/database";
import { checkArithmeticAnswer } from "@aistudy/domain";
import { createOpeningTeachingCommandService } from "../../apps/web/src/features/opening/teaching/command-service";
import { createOpeningAttemptService } from "../../apps/web/src/features/opening/learning/attempt-service";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { learningAttemptFixture } from "./opening-learning-attempt-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
async function seed(text = "计算 1/2 + 1/3\n通分后得到 5/6。") {
  const base = await learningAttemptFixture(f);
  const activity = await createOpeningTeachingActivitiesRepository(f.sql).create(f.scope, {
    clientKey: randomUUID(), intentKind: "topic", intentSummary: "有理数加法", courseId: base.courseId,
    sourceIds: [base.sourceId], createIntent: {},
  });
  const blockId = randomUUID(), promptId = randomUUID(), answerId = randomUUID();
  const blocks = [
    { id: blockId, type: "example", content: { text } },
    { id: promptId, type: "prompt", content: { text: "计算 1/4+1/3", skillLabel: "有理数加法" } },
    { id: answerId, type: "answer_key", content: { answer: "7/12", hidden: true } },
  ];
  const content = createOpeningTeachingContentRepository(f.sql), commands = createOpeningTeachingCommandsRepository(f.sql);
  const unit = await content.createUnit(f.scope, { title: "分数加法", blocks });
  await content.publishActivitySpec(f.scope, { activityId: activity.id, teachingUnitId: unit.id, expectedVersion: 0,
    expectedRevisionNumber: 1, revisionNumber: 1,
    blockOrder: blocks.map((block, position) => ({ blockId: block.id, blockType: block.type, role: block.type as "example" | "prompt" | "answer_key", position })),
    sourceRefs: [{ sourceId: base.sourceId, version: 1, chunkId: base.chunkId }],
  });
  const drafts = [{ blockId, contentVersion: 1, draftText: "保留原题推导" }];
  await f.sql`UPDATE opening_teaching_activities SET checkpoint_json=${f.sql.json({ drafts, draftHistory: [{ text: "旧草稿" }], custom: true })} WHERE id=${activity.id}`;
  const session = await base.learning.createSession(f.scope, { activityId: activity.id, courseId: base.courseId, skillLabel: "有理数加法", sourceIds: [base.sourceId] });
  const attempts = createOpeningAttemptService(f.sql);
  const start = (contentVersion: number) => attempts.create(f.scope, { sessionId: session.id, clientKey: randomUUID(), teachingBlock: { blockId: promptId, contentVersion } });
  const request = (expectedVersion = 1, clientKey = randomUUID()) => ({ kind: "example" as const, clientKey, blockId, expectedVersion, expectedPathVersion: 1, expectedRevisionNumber: expectedVersion });
  const command = (version = 1, key = randomUUID()) => createOpeningTeachingCommandService(f.sql).execute(f.scope, activity.id, request(version, key));
  const state = async () => {
    const [activityState] = await f.sql`SELECT content_version,path_version,checkpoint_json,generate_status FROM opening_teaching_activities WHERE id=${activity.id}`;
    const [spec] = await f.sql`SELECT revision_number,block_order,version FROM opening_teaching_activity_specs WHERE activity_id=${activity.id}`;
    const [document] = await f.sql`SELECT current_revision_number FROM library_documents WHERE id=${unit.documentId}`;
    const revisions = await f.sql`SELECT revision_number,blocks FROM library_revisions WHERE document_id=${unit.documentId} ORDER BY revision_number`;
    const exposures = await f.sql`SELECT * FROM opening_help_exposures WHERE activity_id=${activity.id}`;
    return { activity: activityState, spec, document, revisions, exposures };
  };
  return { ...base, activity, unit, blockId, promptId, answerId, content, commands, drafts, start, attempts, request, command, state, session };
}

it("publishes genuinely new complete body atomically, retaining original, hidden key, drafts and assisted evidence", async () => {
  const s = await seed(), before = await s.state();
  const old = await s.start(1);
  const result = await s.command();
  expect(result).toMatchObject({ ok: true, contentVersion: 2, pathVersion: 1, revisionNumber: 2 });
  if (!result.ok) throw new Error("expected supported worked example");
  const init = result.clientInit!;
  const next = init.blocks.at(-1)!;
  const body = next.content as { text: string; stem: string; answer: string; steps: string[]; workedExampleOf: Record<string, unknown> };
  expect(next.role).toBe("example");
  expect(next.blockId).not.toBe(s.blockId);
  expect(body.text).not.toBe((init.blocks[0]!.content as {text: string}).text);
  expect(body.steps).toHaveLength(5);
  expect(checkArithmeticAnswer(body.stem, body.answer)).toBe("correct");
  expect(body.workedExampleOf).toMatchObject({ blockId: s.blockId, contentVersion: 1, revisionNumber: 1, skillLabel: "有理数加法", sourceRefs: [{ sourceId: s.sourceId, version: 1, chunkId: s.chunkId }] });
  expect(init.blocks.find(block => block.blockId === s.answerId)!.content).toBeNull();
  const after = await s.state();
  expect(after.revisions).toHaveLength(2);
  expect(after.revisions[0]).toEqual(before.revisions[0]);
  expect(after.activity!.checkpoint_json).toMatchObject({ drafts: s.drafts, draftHistory: [{ text: "旧草稿" }], custom: true });
  expect(after.spec).toMatchObject({ version: 2, revision_number: 2 });
  expect(after.document).toMatchObject({ current_revision_number: 2 });
  expect(after.exposures).toHaveLength(2);
  expect(after.exposures.every(row => row.delivered && row.level === "revealed" && row.initiated_by === "user")).toBe(true);
  const nextAttempt = await s.start(2);
  expect(nextAttempt.stemSnapshot).toBe(old.stemSnapshot);
  const observation = await s.attempts.submit(f.scope, nextAttempt.id, { clientKey: randomUUID(), answer: "7/12", outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
  expect(observation.eligibility?.independentAttempt).toBe("no");
  expect(observation.allowsIndependent).toBe(false);
  expect(await f.sql`SELECT id FROM learning_events WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_budget_reservations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});

it("replays a lost response once, rejects changed intent and survives bounded replay eviction", async () => {
  const s = await seed(), key = randomUUID();
  expect(await s.command(1, key)).toMatchObject({ ok: true, replayed: false });
  const saved = await s.state();
  expect(await s.command(1, key)).toMatchObject({ ok: true, replayed: true, contentVersion: 2 });
  expect(await s.command(2, key)).toMatchObject({ ok: false, conflict: "client_key_intent_mismatch" });
  expect(await s.state()).toEqual(saved);
  await f.sql`UPDATE opening_teaching_activities SET checkpoint_json=checkpoint_json-'commandLog'-'commandReplay' WHERE id=${s.activity.id}`;
  const evicted = await s.state();
  expect(await s.command(2, key)).toMatchObject({ ok: false, conflict: "validation" });
  expect(await s.state()).toEqual(evicted);
});

it("retains demonstrated help after another unchanged-question publication", async () => {
  const s = await seed();
  await s.command();
  await s.start(2);
  const result = await s.commands.executeCommand(f.scope, s.activity.id, { ...s.request(2), kind: "rephrase", blockId: s.promptId });
  expect(result).toMatchObject({ ok: true, contentVersion: 3 });
  const attempt = await s.start(3);
  const observation = await s.attempts.submit(f.scope, attempt.id, { clientKey: randomUUID(), answer: "7/12", outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
  expect(observation.eligibility?.independentAttempt).toBe("no");
  expect(observation.allowsIndependent).toBe(false);
});

it("serializes concurrent CAS requests and concurrent duplicate delivery", async () => {
  const s = await seed();
  const results = await Promise.all([s.command(), s.command()]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.filter(result => !result.ok)).toMatchObject([{ conflict: "stale_content_version" }]);
  expect((await s.state()).revisions).toHaveLength(2);
  const second = await seed(), key = randomUUID();
  const duplicate = await Promise.all([second.command(1, key), second.command(1, key)]);
  expect(duplicate.every(result => result.ok)).toBe(true);
  expect(duplicate.filter(result => result.ok && result.replayed)).toHaveLength(1);
  expect((await second.state()).revisions).toHaveLength(2);
});

it.each(["proof", "invalid", "prompt", "unknown", "source", "document", "path", "owner"] as const)("refuses %s without partial publication", async mode => {
  const s = await seed(mode === "proof" ? "证明所有矩阵都可逆。" : mode === "invalid" ? "计算 1/0+2/3" : undefined);
  if (mode === "unknown") await f.sql`UPDATE opening_teaching_activities SET generate_status='unknown' WHERE id=${s.activity.id}`;
  if (mode === "source") {
    await f.sql`UPDATE opening_sources SET version=version+1 WHERE id=${s.sourceId}`;
    await f.sql`UPDATE opening_source_chunks SET source_version=2 WHERE id=${s.chunkId}`;
  }
  if (mode === "document") await s.content.writeUnitBlocks(f.scope, s.unit.id, [{ id: s.blockId, type: "example", content: { text: "计算 3/4+2/5" } }]);
  if (mode === "path") await f.sql`UPDATE opening_teaching_activities SET path_version=2 WHERE id=${s.activity.id}`;
  const before = await s.state();
  if (mode === "owner") await expect(s.commands.executeCommand(f.otherScope, s.activity.id, s.request())).rejects.toMatchObject({ code: "NOT_FOUND" });
  else {
    const result = mode === "prompt" ? await s.commands.executeCommand(f.scope, s.activity.id, { ...s.request(), blockId: s.promptId }) : await s.command();
    expect(result.ok).toBe(false);
  }
  expect(await s.state()).toEqual(before);
});

it("rolls library and spec back when activity CAS fails after body preparation", async () => {
  const s = await seed(), before = await s.state();
  const injected = new Proxy(f.sql, {
    get(target, property) {
      if (property !== "begin") return Reflect.get(target, property);
      return (callback: (tx: TransactionSql) => Promise<unknown>) => f.sql.begin(tx => callback(new Proxy(tx, {
        apply(targetTx, self, args: [TemplateStringsArray, ...unknown[]]) {
          const query = args[0].join("?");
          if (query.includes("UPDATE opening_teaching_activities") && query.includes("SET content_version")) return Promise.resolve([]);
          return Reflect.apply(targetTx, self, args);
        },
      })));
    },
  }) as Sql;
  await expect(createOpeningTeachingCommandsRepository(injected).executeCommand(f.scope, s.activity.id, s.request()))
    .rejects.toMatchObject({ code: "CONFLICT" });
  expect(await s.state()).toEqual(before);
});

it("refuses duplicate finite supply after six complete distinct worked examples", async () => {
  const s = await seed();
  const bodies: string[] = [];
  for (let version = 1; version <= 6; version++) {
    const result = await s.command(version);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected supply exhaustion");
    const body = result.clientInit!.blocks.at(-1)!.content as {stem: string};
    expect(bodies).not.toContain(body.stem); bodies.push(body.stem);
  }
  const before = await s.state();
  expect(await s.command(7)).toMatchObject({ ok: false, conflict: "validation" });
  expect(await s.state()).toEqual(before);
});
