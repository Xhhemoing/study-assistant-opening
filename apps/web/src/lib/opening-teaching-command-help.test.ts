import { expect, it } from "vitest";
import { databaseNoPriorItem } from "./opening-teaching-command-help.fixture";

it.each(["rephrase", "expand"] as const)("keeps released help before the first attempt after unchanged %s, without start(2)", async kind => {
  const db = databaseNoPriorItem("求函数 f(x)=x^2 的导数。");
  expect((await db.qualify()).result.independentAttempt).toBe("yes");
  expect(await db.command()).toMatchObject({ ok: true, contentVersion: 2 });
  expect((await db.qualify()).result.independentAttempt).toBe("no");
  const original = structuredClone(db.state().receipts);
  expect(await db.command({ kind, clientKey: `no-item-${kind}`, blockId: db.promptId,
    expectedVersion: 2, expectedPathVersion: 1, expectedRevisionNumber: 2 })).toMatchObject({ ok: true, contentVersion: 3 });
  expect((await db.readQuestion()).stem).toBe("计算 1/4+1/3");
  const after = await db.qualify();
  expect(after.result.independentAttempt).toBe("no");
  const carried = db.state().receipts.filter(row => (row.context_anchor as { contentVersion: number }).contentVersion === 3);
  expect(carried).toHaveLength(1);
  expect(carried[0]!.delivered_at).toBe(original[1]!.delivered_at);
  expect(carried[0]!.workspace_history_revision).toBe(original[1]!.workspace_history_revision);
});


it.each(["stem", "interaction", "ref", "source", "version", "answer-key"] as const)("does not carry across a changed publication: %s", async change => {
  const db = databaseNoPriorItem("求函数 f(x)=x^2 的导数。");
  expect(await db.command()).toMatchObject({ ok: true, contentVersion: 2 });
  db.publishChanged(state => {
    const prompt = state.revisions.at(-1)!.blocks.find(block => block.id === db.promptId)!;
    if (change === "stem") prompt.content.text = "计算 1/5+1/3";
    if (change === "interaction") prompt.content.interaction = { kind: "numeric", unit: "米" };
    if (change === "ref") state.spec.source_refs = [];
    if (change === "source") state.activity.source_ids = [];
    if (change === "version") state.spec.source_refs[0]!.version = 2;
    if (change === "answer-key") { prompt.type = "answer_key"; state.spec.block_order.find(ref => ref.blockId === db.promptId)!.role = "answer_key"; }
  });
  expect(await db.command({ kind: "rephrase", clientKey: `changed-${change}`, blockId: db.promptId,
    expectedVersion: 3, expectedPathVersion: 1, expectedRevisionNumber: 3 })).toMatchObject({ ok: true, contentVersion: 4 });
  expect(db.state().receipts.some(row => (row.context_anchor as { contentVersion: number }).contentVersion === 4)).toBe(false);
  expect((await db.qualify()).input.context.helpHistory?.exposures).toEqual([]);
});

it.each(["source", "version", "document", "revision", "ref", "blocks", "unit", "unreleased", "generic"] as const)("rejects incomplete/changed receipt binding: %s", async change => {
  const db = databaseNoPriorItem("求函数 f(x)=x^2 的导数。");
  expect(await db.command()).toMatchObject({ ok: true, contentVersion: 2 });
  const question = db.state().receipts.find(row => (row.context_anchor as { blockId: string }).blockId === db.promptId)!;
  const binding = (question.release_intent as { teachingPublication: { documentId: string; revisionNumber: number; teachingUnitId: string; sourceRefs: unknown; blockOrder: unknown; blocks: unknown } }).teachingPublication;
  if (change === "source") binding.sourceRefs = [];
  if (change === "version") db.state().sourceVersion = 2;
  if (change === "document") binding.documentId = db.promptId;
  if (change === "revision") binding.revisionNumber = 1;
  if (change === "ref") binding.blockOrder = [];
  if (change === "blocks") binding.blocks = [];
  if (change === "unit") binding.teachingUnitId = db.promptId;
  if (change === "unreleased") { question.delivered = false; question.released_at = null; }
  if (change === "generic") question.release_key = "generic-help-not-command";
  expect(await db.command({ kind: "rephrase", clientKey: `binding-${change}`, blockId: db.promptId,
    expectedVersion: 2, expectedPathVersion: 1, expectedRevisionNumber: 2 })).toMatchObject({ ok: true, contentVersion: 3 });
  expect(db.state().receipts.some(row => (row.context_anchor as { contentVersion: number }).contentVersion === 3)).toBe(false);
});


it("keeps original delivery time through repeated unchanged publications with no prior item", async () => {
  const db = databaseNoPriorItem("求函数 f(x)=x^2 的导数。");
  expect(await db.command()).toMatchObject({ ok: true, contentVersion: 2 });
  const deliveredAt = db.state().receipts[1]!.delivered_at;
  for (let version = 2; version < 5; version++) {
    expect(await db.command({ kind: "rephrase", clientKey: `repeat-${version}`, blockId: db.promptId,
      expectedVersion: version, expectedPathVersion: 1, expectedRevisionNumber: version })).toMatchObject({ ok: true, contentVersion: version + 1 });
    expect((await db.qualify()).result.independentAttempt).toBe("no");
    expect(db.state().receipts.at(-1)!.delivered_at).toBe(deliveredAt);
  }
});
