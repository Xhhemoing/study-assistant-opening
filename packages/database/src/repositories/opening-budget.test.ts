import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { createOpeningBudgetRepository } from "./opening-budget";

const scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
};
const reservationId = "33333333-3333-4333-8333-333333333333";
const parentId = `study-ephemeral:${scope.workspaceId}:lesson`;

describe("ephemeral execution claims", () => {
  it.each([
    ["eph:lesson", "eph:lesson:fallback"],
    ["eph:lesson:fallback", "eph:lesson"],
  ])("exports a claim for %s only after fencing %s in the same transaction", async (requestId, siblingId) => {
    const claims: string[] = [];
    const fences: string[] = [];
    const tag = (inTransaction: boolean) => async (strings: TemplateStringsArray, ...bindings: unknown[]) => {
      const query = strings.join("?");
      if (!strings.join("").trim()) return [];
      if (query.includes("FROM workspaces")) return [{ id: scope.workspaceId }];
      if (query.includes("SELECT request_id, parent_interaction_id")) {
        return [{ request_id: requestId, parent_interaction_id: parentId, purpose: "tutor" }];
      }
      if (query.includes("UPDATE opening_budget_reservations")) {
        expect(inTransaction).toBe(true);
        expect(bindings).toContain(reservationId);
        claims.push(requestId);
        return [{ id: reservationId }];
      }
      if (query.includes("INSERT INTO opening_budget_reservations")) {
        expect(inTransaction).toBe(true);
        const keys = bindings.find(Array.isArray) as string[];
        fences.push(...keys);
      }
      return [];
    };
    const sql = Object.assign(tag(false), {
      begin: async (run: (tx: ReturnType<typeof tag>) => Promise<boolean>) => run(tag(true)),
    }) as unknown as Sql;
    const repo = createOpeningBudgetRepository(sql, { envCapCents: 100 });

    await expect(repo.claimExecution(scope, reservationId)).resolves.toBe(true);
    expect(claims).toEqual([requestId]);
    expect(fences).toEqual([siblingId]);
  });
});
