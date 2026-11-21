import { describe, expect, it, vi } from "vitest";
import { readOpeningAssistantReviewCandidates } from "./opening-review-candidates";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };

function candidate(id: string, hasMemoryDependencies: boolean) {
  return {
    id, source_turn_id: `turn-${id}`, workspace_id: scope.workspaceId, status: "pending",
    payload: { kind: "task", title: "Review", minutes: 10, dueText: null },
    created_at: new Date(0), updated_at: new Date(0),
    has_memory_dependencies: hasMemoryDependencies,
  };
}

function sqlStub(rows: ReturnType<typeof candidate>[], allowedTurnIds: string[] = []) {
  const tx = vi.fn(async (parts: TemplateStringsArray) => {
    const query = parts.join(" ");
    if (query.includes("SELECT t.id FROM opening_turns")) return allowedTurnIds.map(id => ({ id }));
    if (query.includes("SELECT a.id") || query.includes("SELECT a.*") || query.includes("SELECT c.*")) return rows;
    return [];
  });
  const begin = vi.fn(async (_options: string, run: (sql: typeof tx) => Promise<unknown>) => run(tx));
  return { sql: Object.assign(tx, { begin }), tx, begin };
}

describe("readOpeningAssistantReviewCandidates", () => {
  it("reads material-admitted candidates without planning a memory walk when no turn has dependencies", async () => {
    const { sql, tx } = sqlStub([candidate("ordinary", false)]);
    const result = await readOpeningAssistantReviewCandidates(sql as never, scope);
    expect(result.map(row => row.id)).toEqual(["ordinary"]);
    expect(tx.mock.calls.some(([query]) => query.join("").includes("WITH RECURSIVE mem_deps"))).toBe(false);
  });

  it("probes only memory-dependent turns in the same read snapshot and hides rejected lineage", async () => {
    const { sql, tx, begin } = sqlStub(
      [candidate("ordinary", false), candidate("expired", true), candidate("live", true)],
      ["turn-live"],
    );
    const result = await readOpeningAssistantReviewCandidates(sql as never, scope);
    expect(result.map(row => row.id)).toEqual(["ordinary", "live"]);
    expect(begin).toHaveBeenCalledOnce();
    const probe = tx.mock.calls.find(([query]) => query.join(" ").includes("SELECT t.id FROM opening_turns"));
    expect(probe).toContainEqual(["turn-expired", "turn-live"]);
  });
});
