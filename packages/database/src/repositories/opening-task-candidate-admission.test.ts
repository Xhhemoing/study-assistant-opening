import type { TransactionSql } from "postgres";
import { describe, expect, it } from "vitest";
import { admitTaskCandidate } from "./opening-task-candidate-admission";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const turnId = "33333333-3333-4333-8333-333333333333";
const candidateId = "44444444-4444-4444-8444-444444444444";

function stub(ancestor: "none" | "active" | "expired" | "revoked" | "superseded") {
  const queries: string[] = [];
  const tx = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.reduce((text, part, i) => text + part + (i < values.length ? String(values[i]) : ""), "")
      .replace(/\s+/g, " ").trim();
    return {
      toString: () => query,
      then(resolve: (rows: unknown[]) => unknown) {
        queries.push(query);
        if (query.startsWith("SELECT c.payload")) return resolve([{
          payload: { kind: "task", title: "Do the exercise", minutes: 15, dueText: null },
          source_turn_id: turnId, has_memory_dependencies: ancestor !== "none",
        }]);
        if (query.startsWith("SELECT t.id FROM opening_turns")) {
          return resolve(ancestor === "active" ? [{ id: turnId }] : []);
        }
        return resolve([{ id: candidateId }]);
      },
    };
  }) as unknown as TransactionSql;
  return { tx, queries };
}

describe("admitTaskCandidate", () => {
  it("keeps ordinary candidates on the non-recursive path", async () => {
    const { tx, queries } = stub("none");
    await expect(admitTaskCandidate(tx, scope, candidateId)).resolves.toBeNull();
    expect(queries.some(q => q.includes("WITH RECURSIVE"))).toBe(false);
  });

  it.each(["expired", "revoked", "superseded"] as const)("rejects stale candidates with %s memory ancestry", async ancestor => {
    const { tx, queries } = stub(ancestor);
    await expect(admitTaskCandidate(tx, scope, candidateId)).rejects.toMatchObject({ code: "VALIDATION" });
    const probe = queries.at(-1);
    expect(probe).toContain("WITH RECURSIVE mem_deps");
    expect(probe).toContain("clock_timestamp()");
    expect(probe).toContain(turnId);
  });

  it("admits a candidate with usable memory ancestry", async () => {
    const { tx } = stub("active");
    await expect(admitTaskCandidate(tx, scope, candidateId)).resolves.toBe(turnId);
  });
});
