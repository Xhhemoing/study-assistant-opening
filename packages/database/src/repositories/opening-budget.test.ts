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
  ])("exports a claim for %s only after fencing %s in ascending order", async (requestId, siblingId) => {
    const events: string[] = [];
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
        events.push(`claim:${requestId}`);
        return [{ id: reservationId }];
      }
      if (query.includes("INSERT INTO opening_budget_reservations")) {
        expect(inTransaction).toBe(true);
        const keys = bindings.filter(Array.isArray).find(values =>
          values.some(value => String(value).startsWith("eph:") || String(value).startsWith("eph-v2:"))) as string[] | undefined;
        if (keys) {
          fences.push(...keys);
          events.push(...keys.map(key => `fence:${key}`));
        }
      }
      return [];
    };
    const tx = Object.assign(tag(true), {
      savepoint: async (run: (sp: unknown) => Promise<unknown>) => run(tx),
    });
    const sql = Object.assign(tag(false), {
      begin: async (run: (txArg: typeof tx) => Promise<boolean>) => run(tx),
    }) as unknown as Sql;
    const repo = createOpeningBudgetRepository(sql, { envCapCents: 100 });

    await expect(repo.claimExecution(scope, reservationId)).resolves.toBe(true);
    const clientKey = requestId.replace(/^eph:/, "").replace(/:fallback$/, "");
    const encoded = `eph-v2:${scope.workspaceId}:${Buffer.from(clientKey, "utf16le").toString("base64url")}`;
    expect(fences).toEqual(expect.arrayContaining([
      siblingId,
      requestId.startsWith("eph:") ? encoded : `eph:${clientKey}`,
      `${encoded}:fallback`,
    ]));
    expect(fences).toHaveLength(3);
    const claimIndex = events.indexOf(`claim:${requestId}`);
    expect(claimIndex).toBeGreaterThan(0);
    for (const key of fences) {
      const idx = events.indexOf(`fence:${key}`);
      if (key < requestId) expect(idx).toBeLessThan(claimIndex);
      else expect(idx).toBeGreaterThan(claimIndex);
    }
  });

  it("fences both legacy and encoded rollback siblings for an encoded reservation", async () => {
    const clientKey = "encoded-lesson";
    const encoded = `eph-v2:${scope.workspaceId}:${Buffer.from(clientKey, "utf16le").toString("base64url")}`;
    const requestId = encoded;
    const parentId = `study-ephemeral:${scope.workspaceId}:${clientKey}`;
    const events: string[] = [];
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
        events.push(`claim:${requestId}`);
        return [{ id: reservationId }];
      }
      if (query.includes("INSERT INTO opening_budget_reservations")) {
        expect(inTransaction).toBe(true);
        const keys = bindings.filter(Array.isArray).find(values =>
          values.some(value => String(value).startsWith("eph:") || String(value).startsWith("eph-v2:"))) as string[] | undefined;
        if (keys) {
          fences.push(...keys);
          events.push(...keys.map(key => `fence:${key}`));
        }
      }
      return [];
    };
    const tx = Object.assign(tag(true), {
      savepoint: async (run: (sp: unknown) => Promise<unknown>) => run(tx),
    });
    const sql = Object.assign(tag(false), {
      begin: async (run: (txArg: typeof tx) => Promise<boolean>) => run(tx),
    }) as unknown as Sql;
    const repo = createOpeningBudgetRepository(sql, { envCapCents: 100 });

    await expect(repo.claimExecution(scope, reservationId)).resolves.toBe(true);
    expect(fences).toEqual([
      `${encoded}:fallback`,
      `eph:${clientKey}`,
      `eph:${clientKey}:fallback`,
    ]);
    expect(events[0]).toBe(`claim:${requestId}`);
  });

  it("rolls back the savepoint and skips after-fences when claim fails", async () => {
    const requestId = "eph:lesson:fallback";
    const committed: string[] = [];
    let staged: string[] = [];
    const tag = async (strings: TemplateStringsArray, ...bindings: unknown[]) => {
      const query = strings.join("?");
      if (!strings.join("").trim()) return [];
      if (query.includes("FROM workspaces")) return [{ id: scope.workspaceId }];
      if (query.includes("SELECT request_id, parent_interaction_id")) {
        return [{ request_id: requestId, parent_interaction_id: parentId, purpose: "tutor" }];
      }
      if (query.includes("UPDATE opening_budget_reservations")) return [];
      if (query.includes("INSERT INTO opening_budget_reservations")) {
        const keys = bindings.filter(Array.isArray).find(values =>
          values.some(value => String(value).startsWith("eph"))) as string[] | undefined;
        if (keys) staged.push(...keys);
      }
      return [];
    };
    const tx = Object.assign(tag, {
      savepoint: async (run: (sp: unknown) => Promise<unknown>) => {
        const snapshot = [...staged];
        try {
          const result = await run(tx);
          committed.push(...staged);
          return result;
        } catch (error) {
          staged = snapshot;
          throw error;
        }
      },
    });
    const sql = Object.assign(tag, {
      begin: async (run: (txArg: typeof tx) => Promise<boolean>) => run(tx),
    }) as unknown as Sql;
    const repo = createOpeningBudgetRepository(sql, { envCapCents: 100 });

    await expect(repo.claimExecution(scope, reservationId)).resolves.toBe(false);
    expect(staged).toEqual([]);
    expect(committed).toEqual([]);
  });
});
