import { describe, expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";
import { readOpeningTeachingBlindSolveKeyMetadata } from "./opening-teaching-question-evaluation";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) };
const identity = { activityId: id(3), teachingRevisionId: id(4), blockId: id(5), answerBlockId: id(6),
  questionText: "2+2", keyText: "4", contentVersion: 1, sourceVersions: { [id(7)]: 1, [id(8)]: 2 },
  generatorModelIdentity: { providerId: "g", modelName: "g", family: "a" } };
const receipt = { protocol: "teaching-blind-solve-1", identity, operationId: "solve:job:block",
  modelSnapshot: { id: "s", providerId: "s", modelName: "s", inputCentsPerMillion: 1, outputCentsPerMillion: 1 },
  family: "b", decision: "match", solverAnswer: "4", reasonCodes: ["pinned_key_match"], costLedgerRef: "ledger" };
const row = { receipt, blocks: [{ id: id(5), type: "prompt", content: { text: "2+2", interaction: { kind: "numeric" } } },
  { id: id(6), type: "answer_key", content: { answer: "4" } }],
  block_order: [{ blockId: id(5), position: 0, role: "prompt", blockType: "prompt" }, { blockId: id(6), position: 1, role: "answer_key", blockType: "answer_key" }],
  source_refs: [{ sourceId: id(7), version: 1 }, { sourceId: id(8), version: 2 }] };
function fixture(rows: unknown[]) {
  const query = vi.fn(async (_parts: TemplateStringsArray, ..._values: unknown[]) => rows);
  const tx = Object.assign(query, { json: (value: unknown) => value }) as unknown as TransactionSql;
  return { query, run: (current = identity) => readOpeningTeachingBlindSolveKeyMetadata(tx, scope, current) };
}

describe("blind-solve saved source identity is bound to the exact published version set", () => {
  it("accepts both current sources even when publication references are reordered", async () => {
    expect(await fixture([{ ...row, source_refs: [...row.source_refs].reverse() }]).run()).toEqual({ eligibility: "matched_current", receipt });
  });
  it.each([
    ["first source version changed", [{ sourceId: id(7), version: 2 }, row.source_refs[1]]],
    ["second source version changed", [row.source_refs[0], { sourceId: id(8), version: 3 }]],
    ["one source omitted", [row.source_refs[0]]],
    ["extra source added", [...row.source_refs, { sourceId: id(9), version: 1 }]],
    ["different source with same version", [row.source_refs[0], { sourceId: id(9), version: 2 }]],
  ])("does not authorize %s", async (_name, source_refs) => {
    expect(await fixture([{ ...row, source_refs }]).run()).toEqual({ eligibility: "unknown", receipt: null });
  });
  it.each([
    ["source 1 revision changed", { ...identity, sourceVersions: { [id(7)]: 2, [id(8)]: 2 } }],
    ["source 2 removed", { ...identity, sourceVersions: { [id(7)]: 1 } }],
    ["foreign source substituted", { ...identity, sourceVersions: { [id(7)]: 1, [id(9)]: 2 } }],
    ["teaching revision changed", { ...identity, teachingRevisionId: id(10) }],
    ["activity changed", { ...identity, activityId: id(11) }],
  ])("does not reuse receipt after %s", async (_name, current) => {
    expect(await fixture([row]).run(current)).toEqual({ eligibility: "unknown", receipt: null });
  });
  it("keeps workspace, owner, activity, revision and versions bound in the actual read", async () => {
    const f = fixture([row]);
    expect(await f.run()).toEqual({ eligibility: "matched_current", receipt });
    const [parts, ...values] = f.query.mock.calls[0]!;
    const sql = (parts as TemplateStringsArray).map((part, index) => `${part}${index < values.length ? `$${index + 1}` : ""}`).join("");
    expect(sql).toMatch(/j\.workspace_id=\$2\s+AND j\.owner_user_id=\$3/);
    expect(sql).toMatch(/s\.activity_id=\$4\s+AND r\.id=\$5\s+AND s\.version=\$6/);
    expect(sql.replace(/\s+/g, " ")).toContain("AND NOT EXISTS (SELECT 1 FROM jsonb_each_text($7) v WHERE NOT EXISTS (SELECT 1 FROM opening_sources source WHERE source.workspace_id=s.workspace_id AND source.id::text=v.key AND source.version::text=v.value AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=source.id)))");
    expect(values).toEqual([identity.blockId, scope.workspaceId, scope.ownerUserId, identity.activityId,
      identity.teachingRevisionId, identity.contentVersion, identity.sourceVersions]);
  });
});
