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

describe("media_usage_upper_bound to vendor_receipt reconciliation", () => {
  function settleSqlMock(initialRow: Record<string, unknown>) {
    let row = { ...initialRow };
    let lateReceiptEvent: { amount_before_cents: number; amount_after_cents: number; reported_actual_cents: number } | null =
      initialRow.has_late_receipt ? { amount_before_cents: 100, amount_after_cents: Number(initialRow.amount_cents), reported_actual_cents: Number(initialRow.amount_cents) } : null;
    const queries: string[] = [];
    const tag = async (strings: TemplateStringsArray, ...bindings: unknown[]): Promise<unknown[]> => {
      const flat = (s: TemplateStringsArray, vals: unknown[]): { text: string; params: unknown[] } => {
        let text = "";
        const params: unknown[] = [];
        for (let i = 0; i < s.length; i++) {
          text += s[i]!;
          if (i < vals.length) {
            const v = vals[i];
            if (v && typeof v === "object" && "__frag" in (v as Record<string, unknown>)) {
              const inner = v as { text: string; params: unknown[] };
              text += inner.text;
              params.push(...inner.params);
            } else {
              text += "?";
              params.push(v);
            }
          }
        }
        return { text, params };
      };
      const compiled = flat(strings, bindings);
      const q = compiled.text;
      if (!q.trim()) return [];
      queries.push(q);
      if (q.includes("FROM workspaces WHERE id")) return [{ id: scope.workspaceId }];
      if (q.includes("SELECT date_trunc('milliseconds', clock_timestamp())")) return [{ instant: new Date("2026-11-21T10:00:00Z") }];
      if (q.includes("SELECT * FROM opening_budget_reservations") && q.includes("FOR UPDATE")) return [row];
      if (q.includes("INSERT INTO opening_budget_reconcile_events") && q.includes("'late_receipt'")) {
        const after = Number(compiled.params[3]);
        const reported = Number(compiled.params[4]);
        if (lateReceiptEvent) {
          if (q.includes("DO UPDATE")) {
            lateReceiptEvent = { ...lateReceiptEvent, amount_after_cents: after, reported_actual_cents: reported };
            return [{ id: "evt-1" }];
          }
          return [];
        }
        lateReceiptEvent = { amount_before_cents: Number(compiled.params[2]), amount_after_cents: after, reported_actual_cents: reported };
        return [{ id: "evt-1" }];
      }
      if (q.includes("UPDATE opening_budget_reservations") && q.includes("settlement_cost_basis")) {
        row = {
          ...row,
          amount_cents: compiled.params[0],
          state: "completed",
          pending_reconcile_cents: 0,
          reconciled_at: row.reconciled_at ?? compiled.params[1],
          updated_at: compiled.params[1],
          result_ref: compiled.params[3] ?? row.result_ref,
          outcome_unknown_at: null,
          settlement_cost_basis: compiled.params[4],
        };
        return [row];
      }
      if (q.includes("FROM workspace_preferences")) return [];
      if (q.includes("SELECT COALESCE(sum(amount_cents), 0) AS used")) return [{ used: row.amount_cents }];
      return [];
    };
    const sqlTag = ((strings: TemplateStringsArray, ...bindings: unknown[]) => {
      if (strings[0]!.includes("ON CONFLICT") || strings[0]!.trimStart().startsWith("workspace_id")) {
        return { __frag: true, text: strings.join("?"), params: bindings };
      }
      return tag(strings, ...bindings);
    }) as unknown as Sql;
    const tx = Object.assign(sqlTag, {});
    const sql = Object.assign(sqlTag, {
      begin: async (run: (txArg: typeof tx) => Promise<unknown>) => run(tx),
    }) as unknown as Sql;
    return { sql, getRow: () => row, getEvent: () => lateReceiptEvent, queries };
  }

  it("allows vendor_receipt after TTL recovery recorded a late_receipt for media_usage_upper_bound and rejects duplicate replay", async () => {
    const mock = settleSqlMock({
      id: reservationId,
      workspace_id: scope.workspaceId,
      parent_interaction_id: null,
      settlement_cost_basis: "media_usage_upper_bound",
      purpose: "transcribe",
      amount_cents: 1,
      reserved_amount_cents: 100,
      request_id: "transcribe:job:0",
      state: "completed",
      model_snapshot: null,
      execution_claimed_at: new Date("2026-11-21T09:00:00Z"),
      outcome_unknown_at: null,
      release_reason: null,
      result_ref: "transcribe:job:0",
      reconciled_at: new Date("2026-11-21T09:35:00Z"),
      pending_reconcile_cents: 0,
      has_late_receipt: true,
    });
    const repo = createOpeningBudgetRepository(mock.sql, { envCapCents: 10_000 });
    const settled = await repo.settle(scope, reservationId, 3, { costBasis: "vendor_receipt" });
    expect(settled).toMatchObject({ amountCents: 3, settlementCostBasis: "vendor_receipt", resultRef: "transcribe:job:0" });
    expect(mock.getEvent()).toEqual({ amount_before_cents: 100, amount_after_cents: 3, reported_actual_cents: 3 });

    await expect(repo.settle(scope, reservationId, 3, { costBasis: "vendor_receipt" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.settle(scope, reservationId, 3)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects duplicate free-tier settlement after TTL recovery settled with media_usage_upper_bound or vendor_receipt", async () => {
    const mock = settleSqlMock({
      id: reservationId,
      workspace_id: scope.workspaceId,
      parent_interaction_id: null,
      settlement_cost_basis: "media_usage_upper_bound",
      purpose: "transcribe",
      amount_cents: 0,
      reserved_amount_cents: 0,
      request_id: "transcribe:job:0",
      state: "completed",
      model_snapshot: null,
      execution_claimed_at: new Date("2026-11-21T09:00:00Z"),
      outcome_unknown_at: null,
      release_reason: null,
      result_ref: "transcribe:job:0",
      reconciled_at: new Date("2026-11-21T09:35:00Z"),
      pending_reconcile_cents: 0,
      has_late_receipt: true,
    });
    const repo = createOpeningBudgetRepository(mock.sql, { envCapCents: 10_000 });
    await expect(repo.settle(scope, reservationId, 0, { resultRef: "transcribe:job:0" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const settled = await repo.settle(scope, reservationId, 0, { costBasis: "vendor_receipt" });
    expect(settled.settlementCostBasis).toBe("vendor_receipt");
    await expect(repo.settle(scope, reservationId, 0, { costBasis: "vendor_receipt" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.settle(scope, reservationId, 0)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("transitions TTL pending reservation -> media_usage_upper_bound -> vendor_receipt -> replay NOT_FOUND", async () => {
    const mock = settleSqlMock({
      id: reservationId,
      workspace_id: scope.workspaceId,
      parent_interaction_id: null,
      settlement_cost_basis: null,
      purpose: "transcribe",
      amount_cents: 100,
      reserved_amount_cents: 100,
      request_id: "transcribe:job:0",
      state: "completed",
      model_snapshot: null,
      execution_claimed_at: new Date("2026-11-21T09:00:00Z"),
      outcome_unknown_at: new Date("2026-11-21T09:35:00Z"),
      release_reason: null,
      result_ref: null,
      reconciled_at: new Date("2026-11-21T09:35:00Z"),
      pending_reconcile_cents: 100,
      has_late_receipt: false,
    });
    const repo = createOpeningBudgetRepository(mock.sql, { envCapCents: 10_000 });
    const provisional = await repo.settle(scope, reservationId, 1, { resultRef: "transcribe:job:0", costBasis: "media_usage_upper_bound" });
    expect(provisional).toMatchObject({ amountCents: 1, settlementCostBasis: "media_usage_upper_bound", pendingReconcileCents: 0 });
    expect(mock.getEvent()).toEqual({ amount_before_cents: 100, amount_after_cents: 1, reported_actual_cents: 1 });

    const final = await repo.settle(scope, reservationId, 3, { costBasis: "vendor_receipt" });
    expect(final).toMatchObject({ amountCents: 3, settlementCostBasis: "vendor_receipt", resultRef: "transcribe:job:0" });
    expect(mock.getEvent()).toEqual({ amount_before_cents: 100, amount_after_cents: 3, reported_actual_cents: 3 });

    await expect(repo.settle(scope, reservationId, 3, { costBasis: "vendor_receipt" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("audits cap_overrun against the reservation local day when next-day vendor_receipt exceeds the prior-day cap", async () => {
    const day1CreatedAt = new Date("2026-11-20T05:00:00Z");
    const day2Clock = new Date("2026-11-21T05:00:00Z");
    let row: Record<string, unknown> = {
      id: reservationId,
      workspace_id: scope.workspaceId,
      parent_interaction_id: null,
      settlement_cost_basis: "media_usage_upper_bound",
      purpose: "transcribe",
      amount_cents: 20,
      reserved_amount_cents: 60,
      request_id: "transcribe:job:0",
      state: "completed",
      model_snapshot: null,
      execution_claimed_at: day1CreatedAt,
      outcome_unknown_at: null,
      release_reason: null,
      result_ref: "transcribe:job:0",
      reconciled_at: null,
      pending_reconcile_cents: 0,
      created_at: day1CreatedAt,
    };
    const alerts: unknown[] = [];
    const overrunRows: Array<{ cap_cents: number; usage_after_cents: number; reported_actual_cents: number }> = [];
    const tag = async (strings: TemplateStringsArray, ...bindings: unknown[]): Promise<unknown[]> => {
      const flat = (s: TemplateStringsArray, vals: unknown[]): { text: string; params: unknown[] } => {
        let text = "";
        const params: unknown[] = [];
        for (let i = 0; i < s.length; i++) {
          text += s[i]!;
          if (i < vals.length) {
            const v = vals[i];
            if (v && typeof v === "object" && "__frag" in (v as Record<string, unknown>)) {
              const inner = v as { text: string; params: unknown[] };
              text += inner.text;
              params.push(...inner.params);
            } else {
              text += "?";
              params.push(v);
            }
          }
        }
        return { text, params };
      };
      const compiled = flat(strings, bindings);
      const q = compiled.text;
      if (!q.trim()) return [];
      if (q.includes("FROM workspaces WHERE id")) return [{ id: scope.workspaceId }];
      if (q.includes("clock_timestamp()")) return [{ instant: day2Clock }];
      if (q.includes("SELECT * FROM opening_budget_reservations") && q.includes("FOR UPDATE")) return [row];
      if (q.includes("INSERT INTO opening_budget_reconcile_events") && q.includes("'late_receipt'")) return [{ id: "evt-late" }];
      if (q.includes("UPDATE opening_budget_reservations") && q.includes("settlement_cost_basis")) {
        row = {
          ...row,
          amount_cents: compiled.params[0],
          state: "completed",
          pending_reconcile_cents: 0,
          reconciled_at: compiled.params[1],
          updated_at: compiled.params[1],
          outcome_unknown_at: null,
          settlement_cost_basis: compiled.params[4],
        };
        return [row];
      }
      if (q.includes("FROM workspace_preferences")) return [{ ai_settings: null, planning_settings: { timeZone: "UTC" } }];
      if (q.includes("SELECT COALESCE(sum(amount_cents), 0) AS used")) {
        const dayStart = compiled.params.find((p): p is Date => p instanceof Date);
        // Day 1 has updated R1 (50) + Day 1 R2 (70) = 120; Day 2 has 0.
        const isDay1 = dayStart?.toISOString().startsWith("2026-11-20");
        return [{ used: isDay1 ? Number(row.amount_cents) + 70 : 0 }];
      }
      if (q.includes("INSERT INTO opening_budget_reconcile_events") && q.includes("'cap_overrun'")) {
        const eventRow = {
          id: "evt-overrun",
          reservation_id: reservationId,
          workspace_id: scope.workspaceId,
          kind: "cap_overrun",
          amount_before_cents: compiled.params[2],
          amount_after_cents: compiled.params[3],
          reported_actual_cents: compiled.params[4],
          state_before: compiled.params[5],
          cap_cents: compiled.params[6],
          usage_after_cents: compiled.params[7],
          created_at: compiled.params[8],
        };
        overrunRows.push({
          cap_cents: Number(eventRow.cap_cents),
          usage_after_cents: Number(eventRow.usage_after_cents),
          reported_actual_cents: Number(eventRow.reported_actual_cents),
        });
        return [eventRow];
      }
      return [];
    };
    const sqlTag = ((strings: TemplateStringsArray, ...bindings: unknown[]) => {
      if (strings[0]!.includes("ON CONFLICT") || strings[0]!.trimStart().startsWith("workspace_id")) {
        return { __frag: true, text: strings.join("?"), params: bindings };
      }
      return tag(strings, ...bindings);
    }) as unknown as Sql;
    const sql = Object.assign(sqlTag, {
      begin: async (run: (txArg: Sql) => Promise<unknown>) => run(sqlTag),
    }) as unknown as Sql;
    const repo = createOpeningBudgetRepository(sql, {
      envCapCents: 100,
      timeZone: "UTC",
      onReconcileAlert: (event) => { alerts.push(event); },
    });
    const settled = await repo.settle(scope, reservationId, 50, { costBasis: "vendor_receipt" });
    expect(settled).toMatchObject({ amountCents: 50, settlementCostBasis: "vendor_receipt" });
    expect(overrunRows).toEqual([{ cap_cents: 100, usage_after_cents: 120, reported_actual_cents: 50 }]);
    expect(alerts).toEqual([expect.objectContaining({ kind: "cap_overrun", capCents: 100, usageAfterCents: 120, reportedActualCents: 50 })]);
  });
});
