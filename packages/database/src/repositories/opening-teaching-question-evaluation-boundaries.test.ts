import { afterEach, describe, expect, it, vi } from "vitest";
import type { Scope } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import { evaluateOpeningTeachingKeyAttempt } from "./opening-teaching-question-evaluation";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const spec = { kind: "teaching_question", specVersion: "teaching-question-v1", blockId: id(1), answerBlockId: id(2), revisionId: id(3),
  activityId: id(4), teachingUnitId: id(5), documentId: id(6), contentVersion: 1, revisionNumber: 1 };
const blocks = [{ id: id(1), type: "prompt", content: { text: "1+1", interaction: { kind: "numeric" } } },
  { id: id(2), type: "answer_key", content: { answer: "2" } }];
const order = [{ blockId: id(1), position: 0, role: "prompt", blockType: "prompt" },
  { blockId: id(2), position: 1, role: "answer_key", blockType: "answer_key" }];
const attempt = { id: id(7), course_id: id(8), problem_id: id(9), item_version_id: id(10), create_intent: { teachingBlock: {} } };
const stages = ["pinned-item", "current-publication", "source", "prior-history", "prior-publication", "prior-source"] as const;
type Stage = typeof stages[number];
function fixture(scope: Scope, failureStage: Stage | undefined, failure: unknown,
  prior?: { prompt?: string; answer?: string; differentBinding?: boolean; version?: number },
  material?: { refs?: unknown; source?: Record<string, unknown> | null }) {
  const events: Stage[] = [];
  let publications = 0, sources = 0;
  const tx = vi.fn((parts: TemplateStringsArray, ..._values: unknown[]): unknown => {
    const query = parts.join("?").replace(/\s+/gu, " ").trim();
    if (query.startsWith("(v.teaching_revision_id IS NULL") || query.startsWith("FOR SHARE")) return { fragment: query };
    let stage: Stage, result: Record<string, unknown>[];
    if (query.startsWith("SELECT v.evaluation_spec,r.blocks")) {
      stage = "pinned-item"; result = [{ evaluation_spec: spec, blocks }];
    } else if (query.startsWith("SELECT r.blocks,s.block_order,s.source_refs")) {
      stage = publications++ ? "prior-publication" : "current-publication";
      const priorBlocks = stage === "prior-publication" && prior ? [
        { ...blocks[0]!, content: { text: prior.prompt ?? "1+1", interaction: { kind: "numeric" } } },
        { ...blocks[1]!, content: { answer: prior.answer ?? "2" } },
      ] : blocks;
      result = [{ blocks: priorBlocks, block_order: order,
        source_refs: material && "refs" in material ? material.refs : [{ sourceId: id(11), version: 1 }] }];
    } else if (query.startsWith("SELECT s.version,s.mime")) {
      stage = sources++ ? "prior-source" : "source";
      result = material && "source" in material ? material.source ? [material.source] : [] : [{ version: 1, mime: "text/plain", has_figures: false }];
    } else if (query.startsWith("SELECT o.id")) {
      stage = "prior-history";
      result = [{ id: id(12), evaluation_spec: { ...spec, ...(prior?.differentBinding ? { activityId: id(40), documentId: id(41) } : {}),
        ...(prior?.version ? { contentVersion: prior.version } : {}) },
        activity_id: prior?.differentBinding ? id(40) : spec.activityId, teaching_block_id: spec.blockId }];
    } else throw new Error(`Unexpected SQL: ${query}`);
    events.push(stage);
    if (stage === failureStage) return Promise.reject(failure);
    return Promise.resolve(result);
  });
  return { tx, events, run: () => evaluateOpeningTeachingKeyAttempt(tx as unknown as TransactionSql, scope, attempt, "2", []) };
}
afterEach(() => vi.restoreAllMocks());

describe("real teaching evaluator: storage failures never become abstain/success", () => {
  for (const stage of stages) it.each([
    { name: "owner denial", code: "FORBIDDEN" }, { name: "pinned version conflict", code: "CONFLICT" },
    { name: "read unavailable", code: "ECONNRESET" }, { name: "ordinary error", code: undefined },
  ])(`${stage}: preserves $name identity without continuing`, async ({ code }) => {
    const error = Object.assign(new Error(`failed ${stage}`), code ? { code } : {});
    const f = fixture({ workspaceId: id(20), ownerUserId: id(21) }, stage, error);
    await expect(f.run()).rejects.toBe(error);
    expect(f.events).toEqual(stages.slice(0, stages.indexOf(stage) + 1));
    for (const [parts] of f.tx.mock.calls) expect(parts.join(" ")).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE)\b/i);
  });
});

describe("real evaluator cannot authorize unavailable/visual/unversioned source material", () => {
  it.each([
    { name: "source absent/excluded", source: null, expectedEvents: 3 },
    { name: "figure chunks on text source", source: { version: 1, mime: "text/plain", has_figures: true }, expectedEvents: 3 },
    { name: "jpeg source", source: { version: 1, mime: "image/jpeg", has_figures: false }, expectedEvents: 3 },
    { name: "png source", source: { version: 1, mime: "image/png", has_figures: false }, expectedEvents: 3 },
    { name: "webp source", source: { version: 1, mime: "image/webp", has_figures: false }, expectedEvents: 3 },
    { name: "missing persisted source refs", refs: undefined, expectedEvents: 2 },
    { name: "null persisted source refs", refs: null, expectedEvents: 2 },
    { name: "empty persisted source refs", refs: [], expectedEvents: 2 },
    { name: "unversioned source ref", refs: [{ sourceId: id(11) }], expectedEvents: 2 },
    { name: "invalid persisted source id", refs: [{ sourceId: "not-a-source", version: 1 }], expectedEvents: 2 },
  ])("$name withholds authority before prior feedback read", async ({ name: _name, expectedEvents, ...material }) => {
    const f = fixture({ workspaceId: id(20), ownerUserId: id(21) }, undefined, undefined, undefined, material);
    expect(await f.run()).toBeNull();
    expect(f.events).toEqual(stages.slice(0, expectedEvents));
    for (const [parts] of f.tx.mock.calls) expect(parts.join(" ")).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE)\b/i);
  });
});

describe("real evaluator history comparison uses resolved content, not just a prior-row count", () => {
  it.each([
    { name: "same binding changed key", prior: { answer: "3" }, decision: null, feedback: false },
    { name: "same binding changed stem", prior: { prompt: "1+2", answer: "3" }, decision: null, feedback: false },
    { name: "same binding changed version", prior: { version: 2 }, decision: null, feedback: false },
    { name: "other binding genuinely different content", prior: { differentBinding: true, prompt: "1+2", answer: "3" }, decision: "correct", feedback: false },
    { name: "other binding inconsistent same-stem key stays conservative", prior: { differentBinding: true, answer: "3" }, decision: "correct", feedback: true },
    { name: "other binding exact equivalent", prior: { differentBinding: true }, decision: "correct", feedback: true },
  ])("$name", async ({ prior, decision, feedback }) => {
    const f = fixture({ workspaceId: id(20), ownerUserId: id(21) }, undefined, undefined, prior);
    const result = await f.run();
    if (decision === null) expect(result).toBeNull();
    else expect(result).toMatchObject({ decision, priorFeedback: feedback });
    expect(f.events).toEqual(stages);
  });
});

describe("real evaluator: independently variable owners/workspaces at each read boundary", () => {
  // Batch1 fixed the owner and varied course only. Here both dimensions vary
  // independently, including two owners in the same workspace; no DB ACL claim.
  const scopes = [
    { workspaceId: id(30), ownerUserId: id(31) }, { workspaceId: id(30), ownerUserId: id(32) },
    { workspaceId: id(33), ownerUserId: id(31) }, { workspaceId: id(33), ownerUserId: id(32) },
  ];
  for (const stage of ["pinned-item", "current-publication", "source", "prior-history"] as const) {
    it.each(scopes)(`${stage} binds supplied scope %j`, async scope => {
      const error = new Error("stop after recording owned query");
      const f = fixture(scope, stage, error);
      await expect(f.run()).rejects.toBe(error);
      const [parts, ...values] = f.tx.mock.calls.at(-1)!;
      const query = parts.join("?");
      expect(values).toContain(scope.workspaceId);
      expect(query).toMatch(/(?:v|s|o)\.workspace_id=\?/);
      if (stage !== "source") {
        expect(values).toContain(scope.ownerUserId);
        expect(query).toMatch(/(?:v|s|o)\.owner_user_id=\?/);
      } else {
        // opening_sources are workspace-owned; do not invent an owner column.
        expect(values).toContain(id(11));
        expect(query).toContain("opening_privacy_exclusions");
      }
      if (stage === "pinned-item") expect(values.slice(0, 4)).toEqual([attempt.item_version_id, attempt.problem_id, scope.workspaceId, scope.ownerUserId]);
      if (stage === "current-publication") expect(values.slice(0, 8)).toEqual([scope.workspaceId, scope.ownerUserId,
        spec.activityId, spec.teachingUnitId, spec.documentId, spec.revisionId, spec.revisionNumber, spec.contentVersion]);
      if (stage === "prior-history") expect(values.slice(0, 3)).toEqual([scope.workspaceId, scope.ownerUserId, attempt.course_id]);
    });
  }
});
