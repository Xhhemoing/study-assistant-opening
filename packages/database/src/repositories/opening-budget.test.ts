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

  function capOverrunHarness(options: {
    initialRow: Record<string, unknown>;
    otherSameDayCents: number;
    envCapCents: number;
    clock?: Date;
  }) {
    let row = { ...options.initialRow };
    let otherSameDayCents = options.otherSameDayCents;
    const events = new Map<string, Record<string, unknown>>();
    const alerts: Array<{ kind: string; capCents: number | null; usageAfterCents: number | null; amountBeforeCents: number; amountAfterCents: number; reportedActualCents: number | null }> = [];
    const clock = options.clock ?? new Date("2026-11-21T05:00:00Z");

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

    const tag = async (strings: TemplateStringsArray, ...bindings: unknown[]): Promise<unknown[]> => {
      const compiled = flat(strings, bindings);
      const q = compiled.text;
      if (!q.trim()) return [];
      if (q.includes("FROM workspaces WHERE id")) return [{ id: scope.workspaceId }];
      if (q.includes("clock_timestamp()")) return [{ instant: clock }];
      if (q.includes("SELECT * FROM opening_budget_reservations") && q.includes("FOR UPDATE")) return [{ ...row }];
      if (q.includes("FROM workspace_preferences")) return [{ ai_settings: null, planning_settings: { timeZone: "UTC" } }];
      if (q.includes("SELECT COALESCE(sum(amount_cents), 0) AS used")) {
        const reservationCharge = row.state === "released" ? 0 : Number(row.amount_cents);
        return [{ used: reservationCharge + otherSameDayCents }];
      }
      if (q.includes("INSERT INTO opening_budget_reconcile_events") && q.includes("'late_receipt'")) {
        const key = `${String(compiled.params[0])}:late_receipt`;
        const existing = events.get(key);
        const after = Number(compiled.params[3]);
        const reported = Number(compiled.params[4]);
        if (existing) {
          if (!q.includes("DO UPDATE")) return [];
          events.set(key, { ...existing, amount_after_cents: after, reported_actual_cents: reported });
          return [{ id: existing.id }];
        }
        const created = {
          id: "evt-late",
          reservation_id: compiled.params[0],
          workspace_id: compiled.params[1],
          kind: "late_receipt",
          amount_before_cents: Number(compiled.params[2]),
          amount_after_cents: after,
          reported_actual_cents: reported,
          state_before: compiled.params[5],
          cap_cents: null,
          usage_after_cents: null,
          created_at: compiled.params[6],
        };
        events.set(key, created);
        return [{ id: created.id }];
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
        return [{ ...row }];
      }
      if (q.includes("INSERT INTO opening_budget_reconcile_events") && q.includes("'cap_overrun'")) {
        const key = `${String(compiled.params[0])}:cap_overrun`;
        const existing = events.get(key);
        const isDailyCapInsert = q.includes("usage_after_cents");
        const candidate = isDailyCapInsert
          ? {
            id: existing?.id ?? "evt-cap",
            reservation_id: compiled.params[0],
            workspace_id: compiled.params[1],
            kind: "cap_overrun",
            amount_before_cents: Number(compiled.params[2]),
            amount_after_cents: Number(compiled.params[3]),
            reported_actual_cents: Number(compiled.params[4]),
            state_before: compiled.params[5],
            cap_cents: Number(compiled.params[6]),
            usage_after_cents: Number(compiled.params[7]),
            created_at: compiled.params[8],
          }
          : {
            id: existing?.id ?? "evt-cap",
            reservation_id: compiled.params[0],
            workspace_id: compiled.params[1],
            kind: "cap_overrun",
            amount_before_cents: Number(compiled.params[2]),
            amount_after_cents: Number(compiled.params[3]),
            reported_actual_cents: Number(compiled.params[4]),
            state_before: compiled.params[5],
            cap_cents: Number(compiled.params[6]),
            usage_after_cents: null,
            created_at: compiled.params[7],
          };
        if (existing) {
          if (q.includes("DO UPDATE") && q.includes("usage_after_cents IS NULL") && existing.usage_after_cents === null) {
            events.set(key, candidate);
            return [candidate];
          }
          return [];
        }
        events.set(key, candidate);
        return [candidate];
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
      envCapCents: options.envCapCents,
      timeZone: "UTC",
      onReconcileAlert: (event) => {
        alerts.push({
          kind: event.kind,
          capCents: event.capCents,
          usageAfterCents: event.usageAfterCents,
          amountBeforeCents: event.amountBeforeCents,
          amountAfterCents: event.amountAfterCents,
          reportedActualCents: event.reportedActualCents,
        });
      },
    });
    return {
      repo,
      alerts,
      getCapOverrun: () => events.get(`${reservationId}:cap_overrun`),
      setOtherSameDayCents: (cents: number) => { otherSameDayCents = cents; },
    };
  }

  it("upgrades reservation-overage cap_overrun to daily-cap cap_overrun and fires alert once when a late receipt exceeds both", async () => {
    const day1 = new Date("2026-11-20T05:00:00Z");
    const h = capOverrunHarness({
      envCapCents: 100,
      otherSameDayCents: 40,
      initialRow: {
        id: reservationId,
        workspace_id: scope.workspaceId,
        parent_interaction_id: null,
        settlement_cost_basis: "media_usage_upper_bound",
        purpose: "transcribe",
        amount_cents: 20,
        reserved_amount_cents: 50,
        request_id: "transcribe:job:0",
        state: "completed",
        model_snapshot: null,
        execution_claimed_at: day1,
        outcome_unknown_at: null,
        release_reason: null,
        result_ref: "transcribe:job:0",
        reconciled_at: null,
        pending_reconcile_cents: 0,
        created_at: day1,
      },
    });

    await h.repo.settle(scope, reservationId, 80, { costBasis: "vendor_receipt" });
    expect(h.getCapOverrun()).toMatchObject({
      cap_cents: 100,
      usage_after_cents: 120,
      amount_before_cents: 40,
      amount_after_cents: 120,
      reported_actual_cents: 80,
    });
    expect(h.alerts).toEqual([{
      kind: "cap_overrun",
      capCents: 100,
      usageAfterCents: 120,
      amountBeforeCents: 40,
      amountAfterCents: 120,
      reportedActualCents: 80,
    }]);

    await expect(h.repo.settle(scope, reservationId, 80, { costBasis: "vendor_receipt" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.alerts).toHaveLength(1);
  });

  it("upgrades an earlier reservation-only cap_overrun on subsequent daily-cap breach without re-alerting already recorded daily-cap replays", async () => {
    const day1 = new Date("2026-11-20T05:00:00Z");
    // Step A: media_usage_upper_bound exceeds reserved_amount_cents (50) while within daily cap (100).
    const h1 = capOverrunHarness({
      envCapCents: 100,
      otherSameDayCents: 0,
      initialRow: {
        id: reservationId,
        workspace_id: scope.workspaceId,
        parent_interaction_id: null,
        settlement_cost_basis: null,
        purpose: "transcribe",
        amount_cents: 50,
        reserved_amount_cents: 50,
        request_id: "transcribe:job:1",
        state: "completed",
        model_snapshot: null,
        execution_claimed_at: day1,
        outcome_unknown_at: day1,
        release_reason: null,
        result_ref: null,
        reconciled_at: day1,
        pending_reconcile_cents: 50,
        created_at: day1,
      },
    });

    await h1.repo.settle(scope, reservationId, 60, { costBasis: "media_usage_upper_bound", resultRef: "transcribe:job:1" });
    expect(h1.getCapOverrun()).toMatchObject({ cap_cents: 50, usage_after_cents: null, reported_actual_cents: 60 });
    expect(h1.alerts).toEqual([{
      kind: "cap_overrun",
      capCents: 50,
      usageAfterCents: null,
      amountBeforeCents: 50,
      amountAfterCents: 60,
      reportedActualCents: 60,
    }]);

    // Step B: subsequent vendor_receipt brings Day-1 total (40 + 75 = 115) over daily cap (100).
    h1.setOtherSameDayCents(40);
    await h1.repo.settle(scope, reservationId, 75, { costBasis: "vendor_receipt" });
    expect(h1.getCapOverrun()).toMatchObject({
      cap_cents: 100,
      usage_after_cents: 115,
      amount_before_cents: 40,
      amount_after_cents: 115,
      reported_actual_cents: 75,
    });
    expect(h1.alerts).toHaveLength(2);
    expect(h1.alerts[1]).toEqual({
      kind: "cap_overrun",
      capCents: 100,
      usageAfterCents: 115,
      amountBeforeCents: 40,
      amountAfterCents: 115,
      reportedActualCents: 75,
    });

    // Step C: if daily-cap overrun was already recorded during media_usage_upper_bound,
    // a subsequent vendor_receipt does not overwrite or double-fire the daily-cap alert.
    const h2 = capOverrunHarness({
      envCapCents: 100,
      otherSameDayCents: 50,
      initialRow: {
        id: reservationId,
        workspace_id: scope.workspaceId,
        parent_interaction_id: null,
        settlement_cost_basis: null,
        purpose: "transcribe",
        amount_cents: 50,
        reserved_amount_cents: 50,
        request_id: "transcribe:job:2",
        state: "completed",
        model_snapshot: null,
        execution_claimed_at: day1,
        outcome_unknown_at: day1,
        release_reason: null,
        result_ref: null,
        reconciled_at: day1,
        pending_reconcile_cents: 50,
        created_at: day1,
      },
    });
    await h2.repo.settle(scope, reservationId, 60, { costBasis: "media_usage_upper_bound", resultRef: "transcribe:job:2" });
    expect(h2.alerts).toHaveLength(1);
    expect(h2.getCapOverrun()).toMatchObject({ cap_cents: 100, usage_after_cents: 110, reported_actual_cents: 60 });

    await h2.repo.settle(scope, reservationId, 75, { costBasis: "vendor_receipt" });
    expect(h2.alerts).toHaveLength(1);
    expect(h2.getCapOverrun()).toMatchObject({ cap_cents: 100, usage_after_cents: 110, reported_actual_cents: 60 });
    await expect(h2.repo.settle(scope, reservationId, 75, { costBasis: "vendor_receipt" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h2.alerts).toHaveLength(1);
  });
});

describe("retrieval turn-family budget aggregation and isolation", () => {
  function turnFamilyLedgerHarness(options: { clock?: Date } = {}) {
    let clock = options.clock ?? new Date("2026-11-21T10:00:00Z");
    let seq = 0;
    const parentBudgets = new Map<string, {
      workspace_id: string;
      id: string;
      budget_cents: number;
      max_provider_calls: number;
      blocked_at: Date | null;
      blocked_reason: string | null;
    }>();
    const reservations = new Map<string, Record<string, unknown>>();
    const reconcileEvents = new Set<string>();
    const queries: Array<{ text: string; params: unknown[] }> = [];

    const normalizeRoot = (id: string): string => {
      let cur = id;
      while (cur.startsWith("retrieval:")) {
        const rest = cur.slice("retrieval:".length);
        if (!rest.trim()) break;
        cur = rest;
      }
      return cur;
    };

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

    const runQuery = async (strings: TemplateStringsArray, ...bindings: unknown[]): Promise<unknown[]> => {
      const compiled = flat(strings, bindings);
      const q = compiled.text;
      if (!q.trim()) return [];
      queries.push(compiled);

      if (q.includes("FROM workspaces WHERE id")) return [{ id: scope.workspaceId }];
      if (q.includes("clock_timestamp()")) return [{ instant: clock }];
      if (q.includes("FROM workspace_preferences")) return [];

      if (q.includes("WITH reconciled AS")) {
        const instant = compiled.params[0] as Date;
        const wsId = compiled.params[3] as string;
        const cutoff = compiled.params[4] as Date;
        for (const row of reservations.values()) {
          if (row.workspace_id === wsId && row.state === "reserved" && (row.created_at as Date) < cutoff) {
            row.state = "completed";
            row.updated_at = instant;
            row.reconciled_at = instant;
            row.outcome_unknown_at = row.outcome_unknown_at ?? instant;
            row.pending_reconcile_cents = row.amount_cents;
            reconcileEvents.add(`${String(row.id)}:ttl_reconciled`);
          }
        }
        return [];
      }

      if (q.includes("FROM opening_budget_reservations") && q.includes("WHERE request_id IN")) {
        const primaryId = compiled.params[0] as string;
        const canonicalFallbackId = compiled.params[1] as string | null;
        const alternateId = compiled.params[2] as string | null;
        const wsId = compiled.params[3] as string;
        const parentId = compiled.params[4] as string | null;
        return [...reservations.values()]
          .filter(r => r.request_id === primaryId
            || (canonicalFallbackId != null && r.request_id === canonicalFallbackId)
            || (alternateId != null && r.request_id === alternateId && r.workspace_id === wsId && r.parent_interaction_id === parentId))
          .map(r => ({ ...r }));
      }

      if (q.includes("SELECT id, state, purpose, result_ref") && q.includes("FROM opening_budget_reservations")) {
        return [];
      }

      if (q.includes("AS has_parent") && q.includes("FROM opening_budget_reservations")) {
        const exactParentId = compiled.params[0] as string;
        const wsId = compiled.params[1] as string;
        const familyIds = compiled.params[2] as string[];
        const rootId = compiled.params[4] as string;
        const matched = [...reservations.values()].filter(r =>
          r.workspace_id === wsId
          && r.parent_interaction_id != null
          && (familyIds.includes(String(r.parent_interaction_id)) || normalizeRoot(String(r.parent_interaction_id)) === rootId),
        );
        if (!matched.length) return [{ has_parent: null, not_sent: null }];
        const hasParent = matched.some(r => r.parent_interaction_id === exactParentId);
        const notSent = matched.every(r =>
          r.state === "released"
          && r.outcome_unknown_at == null
          && Number(r.pending_reconcile_cents ?? 0) === 0
          && (r.release_reason === "not_sent" || r.release_reason === "cancelled"),
        );
        return [{ has_parent: hasParent, not_sent: notSent }];
      }

      if (q.includes("FROM opening_parent_interaction_budgets") && q.includes("SELECT *")) {
        const wsId = compiled.params[0] as string;
        const familyIds = compiled.params[1] as string[];
        const rootId = compiled.params[3] as string;
        return [...parentBudgets.values()]
          .filter(p => p.workspace_id === wsId && (familyIds.includes(p.id) || normalizeRoot(p.id) === rootId))
          .map(p => ({ ...p }));
      }

      if (q.includes("INSERT INTO opening_parent_interaction_budgets")) {
        const [wsId, id, budgetCents, maxCalls, blockedAt, blockedReason] = compiled.params as [
          string, string, number, number, Date | null, string | null,
        ];
        if (!parentBudgets.has(`${wsId}:${id}`)) {
          parentBudgets.set(`${wsId}:${id}`, {
            workspace_id: wsId,
            id,
            budget_cents: budgetCents,
            max_provider_calls: maxCalls,
            blocked_at: blockedAt,
            blocked_reason: blockedReason,
          });
        }
        return [];
      }

      if (q.includes("AS unknown_calls") && q.includes("FROM opening_budget_reservations")) {
        const exactParentId = compiled.params[0] as string;
        const wsId = compiled.params[1] as string;
        const familyIds = compiled.params[2] as string[];
        const rootId = compiled.params[4] as string;
        const matched = [...reservations.values()].filter(r =>
          r.workspace_id === wsId
          && r.parent_interaction_id != null
          && (familyIds.includes(String(r.parent_interaction_id)) || normalizeRoot(String(r.parent_interaction_id)) === rootId),
        );
        let cents = 0;
        let calls = 0;
        let unknownCalls = 0;
        for (const r of matched) {
          const pending = Number(r.pending_reconcile_cents ?? 0);
          const amt = Number(r.amount_cents);
          if (r.state !== "released" || r.outcome_unknown_at != null) {
            cents += Math.max(amt, pending);
          } else if (pending > 0) {
            cents += pending;
          }
          const isFence = r.state === "released" && r.release_reason === "not_sent"
            && amt === 0 && Number(r.reserved_amount_cents ?? 0) === 0
            && r.model_snapshot == null && r.execution_claimed_at == null && r.outcome_unknown_at == null;
          if (!isFence) calls++;
          if (r.outcome_unknown_at != null && r.parent_interaction_id === exactParentId) unknownCalls++;
        }
        return [{ cents, calls, unknown_calls: unknownCalls }];
      }

      if (q.includes("SELECT count(*)::int AS n FROM opening_budget_reservations")) {
        const wsId = compiled.params[0] as string;
        const modelId = compiled.params[1] as string;
        const count = [...reservations.values()].filter(r =>
          r.workspace_id === wsId && r.state !== "released"
          && (r.model_snapshot as { id?: string } | null)?.id === modelId,
        ).length;
        return [{ n: count }];
      }

      if (q.includes("INSERT INTO opening_budget_reservations") && q.includes("SELECT")) {
        const [id, wsId, purpose, amountCents, reservedAmountCents, requestId, modelSnapshot, parentId, createdAt, updatedAt,
          zeroOrUnlimited, checkAmount] = compiled.params as [
          string, string, string, number, number, string, unknown, string | null, Date, Date, boolean, number,
        ];
        if (!zeroOrUnlimited) {
          const used = [...reservations.values()]
            .filter(r => r.workspace_id === wsId && (r.state === "reserved" || r.state === "completed"))
            .reduce((sum, r) => sum + Number(r.amount_cents), 0);
          const cap = Number(compiled.params[compiled.params.length - 1]);
          if (checkAmount + used > cap) return [];
        }
        const uuid = id || `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
        const row = {
          id: uuid,
          workspace_id: wsId,
          parent_interaction_id: parentId,
          settlement_cost_basis: null,
          purpose,
          amount_cents: amountCents,
          reserved_amount_cents: reservedAmountCents,
          request_id: requestId,
          state: "reserved",
          model_snapshot: modelSnapshot,
          execution_claimed_at: null,
          outcome_unknown_at: null,
          release_reason: null,
          result_ref: null,
          reconciled_at: null,
          pending_reconcile_cents: 0,
          created_at: createdAt,
          updated_at: updatedAt,
        };
        reservations.set(uuid, row);
        return [{ ...row }];
      }

      if (q.includes("SELECT request_id, parent_interaction_id, purpose FROM opening_budget_reservations")) {
        const row = reservations.get(String(compiled.params[0]));
        return row ? [{ request_id: row.request_id, parent_interaction_id: row.parent_interaction_id, purpose: row.purpose }] : [];
      }

      if (q.includes("SET execution_claimed_at = now()")) {
        const id = String(compiled.params[0]);
        const row = reservations.get(id);
        if (row && row.state === "reserved" && row.execution_claimed_at == null && row.outcome_unknown_at == null) {
          row.execution_claimed_at = clock;
          row.updated_at = clock;
          return [{ id }];
        }
        return [];
      }

      if (q.includes("SET outcome_unknown_at = COALESCE")) {
        const id = String(compiled.params[0]);
        const row = reservations.get(id);
        if (row && row.state === "reserved") {
          row.outcome_unknown_at = row.outcome_unknown_at ?? clock;
          row.updated_at = clock;
          return [{ ...row }];
        }
        return [];
      }

      if (q.includes("UPDATE opening_budget_reservations") && q.includes("SET state =")) {
        const [newState, releaseReason, resultRef, target] = compiled.params as [string, string | null, string | null, string];
        const row = [...reservations.values()].find(r =>
          (q.includes("request_id =") ? r.request_id === target : r.id === target)
          && r.state === "reserved" && (newState !== "released" || r.outcome_unknown_at == null),
        );
        if (!row) return [];
        row.state = newState;
        row.release_reason = releaseReason;
        row.result_ref = resultRef ?? row.result_ref;
        row.updated_at = clock;
        return [{ ...row }];
      }

      if (q.includes("SELECT * FROM opening_budget_reservations") && q.includes("FOR UPDATE")) {
        const row = reservations.get(String(compiled.params[0]));
        return row ? [{ ...row }] : [];
      }

      if (q.includes("UPDATE opening_parent_interaction_budgets")) {
        const [instant, wsId, familyIds, , rootId] = compiled.params as [Date, string, string[], string, string];
        for (const p of parentBudgets.values()) {
          if (p.workspace_id === wsId && (familyIds.includes(p.id) || normalizeRoot(p.id) === rootId)) {
            p.blocked_at = p.blocked_at ?? instant;
            p.blocked_reason = "actual_exceeded_conservative_bound";
          }
        }
        return [];
      }

      if (q.includes("UPDATE opening_budget_reservations") && q.includes("settlement_cost_basis")) {
        const late = q.includes("pending_reconcile_cents = 0");
        const actualCents = compiled.params[0] as number;
        const instant = compiled.params[1] as Date;
        const resultRef = compiled.params[late ? 3 : 2] as string | null;
        const costBasis = compiled.params[late ? 4 : 3] as string;
        const id = compiled.params[late ? 5 : 4] as string;
        const row = reservations.get(id);
        if (!row) return [];
        row.amount_cents = actualCents;
        row.state = "completed";
        row.updated_at = instant;
        row.result_ref = resultRef ?? row.result_ref;
        row.outcome_unknown_at = null;
        row.pending_reconcile_cents = 0;
        row.settlement_cost_basis = costBasis;
        return [{ ...row }];
      }

      return [];
    };

    const sqlTag = ((strings: TemplateStringsArray, ...bindings: unknown[]) => {
      const head = strings[0]!.trimStart();
      if (!/^(?:SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(head)) {
        return { __frag: true, text: strings.join("?"), params: bindings };
      }
      return runQuery(strings, ...bindings);
    }) as unknown as Sql & { json: (v: unknown) => unknown };
    sqlTag.json = (v: unknown) => v;

    const sql = Object.assign(sqlTag, {
      begin: async (run: (txArg: typeof sqlTag) => Promise<unknown>) => {
        const snapBudgets = new Map([...parentBudgets.entries()].map(([k, v]) => [k, { ...v }]));
        const snapReservations = new Map([...reservations.entries()].map(([k, v]) => [k, { ...v }]));
        try {
          return await run(sqlTag);
        } catch (error) {
          parentBudgets.clear();
          for (const [k, v] of snapBudgets) parentBudgets.set(k, v);
          reservations.clear();
          for (const [k, v] of snapReservations) reservations.set(k, v);
          throw error;
        }
      },
    }) as unknown as Sql;

    return {
      sql,
      queries,
      reservations,
      advanceClock: (ms: number) => { clock = new Date(clock.getTime() + ms); },
      insertFence: (parentInteractionId: string, requestId: string) => {
        const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
        reservations.set(id, {
          id,
          workspace_id: scope.workspaceId,
          parent_interaction_id: parentInteractionId,
          settlement_cost_basis: null,
          purpose: "tutor",
          amount_cents: 0,
          reserved_amount_cents: 0,
          request_id: requestId,
          state: "released",
          model_snapshot: null,
          execution_claimed_at: null,
          outcome_unknown_at: null,
          release_reason: "not_sent",
          result_ref: null,
          reconciled_at: null,
          pending_reconcile_cents: 0,
          created_at: clock,
          updated_at: clock,
        });
      },
    };
  }

  it("aggregates spend across retrieval:<turnId> and <turnId> in unlimited mode while keeping outcome_unknown isolated to retrieval", async () => {
    const h = turnFamilyLedgerHarness();
    const repo = createOpeningBudgetRepository(h.sql, { envCapCents: 0, dailyQuotaMode: "unlimited", parentCapCents: 10 });
    const turnId = "study-turn:turn-1";
    const retrievalId = `retrieval:${turnId}`;

    // 1c embedding times out after send -> outcome_unknown_at set on retrieval:<turnId>.
    const emb = await repo.reserve(scope, {
      purpose: "material-embedding",
      amountCents: 1,
      requestId: "material-query:op-1",
      requestFamily: null,
      parentBudget: { id: retrievalId },
    });
    expect(await repo.claimExecution(scope, emb.id)).toBe(true);
    await repo.markUnknown(scope, emb.id);

    // Exact retry on retrieval:<turnId> replays the unknown reservation without creating a second send.
    const embReplay = await repo.reserve(scope, {
      purpose: "material-embedding",
      amountCents: 1,
      requestId: "material-query:op-1",
      requestFamily: null,
      parentBudget: { id: retrievalId },
    });
    expect(embReplay.replayed).toBe(true);
    expect(embReplay.outcomeUnknownAt).toBeInstanceOf(Date);

    // A different embedding request under retrieval:<turnId> is still blocked by outcome_unknown.
    await expect(repo.reserve(scope, {
      purpose: "material-embedding",
      amountCents: 1,
      requestId: "material-query:op-2",
      requestFamily: null,
      parentBudget: { id: retrievalId },
    })).rejects.toMatchObject({ code: "PARENT_BUDGET_OUTCOME_UNKNOWN" });

    // Tutor requesting 10c under <turnId> exceeds the shared 10c turn-family cap (1c + 10c > 10c).
    await expect(repo.reserve(scope, {
      purpose: "tutor",
      amountCents: 10,
      requestId: "tutor-req-10",
      requestFamily: null,
      parentBudget: { id: turnId },
    })).rejects.toMatchObject({ code: "PARENT_BUDGET_EXCEEDED" });

    // Tutor requesting 9c under <turnId> IS admitted despite retrieval's unknown timeout (1c + 9c <= 10c).
    const tutor = await repo.reserve(scope, {
      purpose: "tutor",
      amountCents: 9,
      requestId: "tutor-req-9",
      requestFamily: null,
      parentBudget: { id: turnId },
    });
    expect(tutor).toMatchObject({ state: "reserved", amountCents: 9, parentInteractionId: turnId });

    // Verify historical behavior: an unknown charge directly on <turnId> still blocks <turnId>.
    await repo.markUnknown(scope, tutor.id);
    await expect(repo.reserve(scope, {
      purpose: "tutor",
      amountCents: 1,
      requestId: "tutor-req-extra",
      requestFamily: null,
      parentBudget: { id: turnId },
    })).rejects.toMatchObject({ code: "PARENT_BUDGET_OUTCOME_UNKNOWN" });
  });

  it("retains TTL-reconciled pending_reconcile_cents and enforces aggregate maxProviderCalls across retrieval and tutor", async () => {
    const h = turnFamilyLedgerHarness();
    const repo = createOpeningBudgetRepository(h.sql, {
      envCapCents: 0,
      dailyQuotaMode: "unlimited",
      parentCapCents: 10,
      unknownAgeMs: 1000,
    });
    const turnId = "study-turn:turn-2";
    const retrievalId = `retrieval:${turnId}`;
    h.insertFence(turnId, "eph:turn-2:fence");

    const emb = await repo.reserve(scope, {
      purpose: "material-embedding",
      amountCents: 1,
      requestId: "material-query:op-ttl",
      requestFamily: null,
      parentBudget: { id: retrievalId, budgetCents: 10, maxProviderCalls: 2 },
    });
    await repo.markUnknown(scope, emb.id);
    h.advanceClock(5000);

    // Even after TTL reconciliation, pending_reconcile_cents = 1c & 1 call remain attributed to the family.
    await expect(repo.reserve(scope, {
      purpose: "tutor",
      amountCents: 10,
      requestId: "tutor-ttl-10",
      requestFamily: null,
      parentBudget: { id: turnId },
    })).rejects.toMatchObject({ code: "PARENT_BUDGET_EXCEEDED" });

    // Admitting tutor (5c, omitting limits) inherits family pinned limits (10c, 2 calls) and counts as call #2.
    const tutor = await repo.reserve(scope, {
      purpose: "tutor",
      amountCents: 5,
      requestId: "tutor-ttl-5",
      requestFamily: null,
      parentBudget: { id: turnId },
    });
    await repo.release(scope, tutor.requestId);

    // 3rd call (1c <= 10c) still hits aggregate maxProviderCalls: 2 across retrieval + tutor (fences excluded).
    await expect(repo.reserve(scope, {
      purpose: "tutor",
      amountCents: 1,
      requestId: "tutor-ttl-call3",
      requestFamily: null,
      parentBudget: { id: turnId },
    })).rejects.toMatchObject({ code: "PARENT_BUDGET_CALL_LIMIT" });

    // Attempting to silently enlarge or alter the family limits from <turnId> rejects with CONFLICT.
    await expect(repo.reserve(scope, {
      purpose: "tutor",
      amountCents: 1,
      requestId: "tutor-ttl-enlarge-calls",
      requestFamily: null,
      parentBudget: { id: turnId, maxProviderCalls: 3 },
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.reserve(scope, {
      purpose: "tutor",
      amountCents: 1,
      requestId: "tutor-ttl-change-budget",
      requestFamily: null,
      parentBudget: { id: turnId, budgetCents: 5 },
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("normalizes nested retrieval prefixes and propagates overage blocks across the turn family", async () => {
    const h = turnFamilyLedgerHarness();
    const repo = createOpeningBudgetRepository(h.sql, { envCapCents: 100, dailyQuotaMode: "limited" });
    const turnId = "study-turn:turn-3";
    const nestedRetrievalId = `retrieval:retrieval:${turnId}`;

    const emb = await repo.reserve(scope, {
      purpose: "material-embedding",
      amountCents: 2,
      requestId: "material-query:op-nested",
      requestFamily: null,
      parentBudget: { id: nestedRetrievalId, budgetCents: 10, maxProviderCalls: 1 },
    });
    // Single-call family limit blocks tutor even under a nested retrieval prefix.
    await expect(repo.reserve(scope, {
      purpose: "tutor",
      amountCents: 1,
      requestId: "tutor-nested-blocked-by-calls",
      requestFamily: null,
      parentBudget: { id: turnId },
    })).rejects.toMatchObject({ code: "PARENT_BUDGET_CALL_LIMIT" });

    // Overage settlement on retrieval:<turnId> blocks the parent turn family as well.
    await repo.settle(scope, emb.id, 5);
    await expect(repo.reserve(scope, {
      purpose: "tutor",
      amountCents: 1,
      requestId: "tutor-after-overage",
      requestFamily: null,
      parentBudget: { id: turnId },
    })).rejects.toMatchObject({ code: "PARENT_BUDGET_BLOCKED" });
  });

  it.each(["reserved", "settled", "outcome_unknown", "ttl_reconciled"] as const)(
    "blocks isParentNotSent when a nested retrieval:retrieval:<turnId> reservation is %s",
    async blockerState => {
      const h = turnFamilyLedgerHarness({ clock: new Date("2026-11-21T10:00:00Z") });
      const repo = createOpeningBudgetRepository(h.sql, { envCapCents: 100, unknownAgeMs: 1000 });
      const turnId = `study-turn:unsent-${blockerState}`;
      const nestedRetrievalId = `retrieval:retrieval:${turnId}`;

      const tutor = await repo.reserve(scope, {
        purpose: "tutor",
        amountCents: 5,
        requestId: `tutor-${blockerState}`,
        requestFamily: null,
        parentBudget: { id: turnId },
      });
      await repo.release(scope, tutor.requestId, "not_sent");
      expect(await repo.isParentNotSent(scope, turnId)).toBe(true);

      const emb = await repo.reserve(scope, {
        purpose: "material-embedding",
        amountCents: 1,
        requestId: `emb-${blockerState}`,
        requestFamily: null,
        parentBudget: { id: nestedRetrievalId },
      });
      if (blockerState === "settled") await repo.settle(scope, emb.id, 1);
      if (blockerState === "outcome_unknown") await repo.markUnknown(scope, emb.id);
      if (blockerState === "ttl_reconciled") {
        await repo.markUnknown(scope, emb.id);
        h.advanceClock(5000);
        // Trigger lazy TTL reconcile on an unrelated turn.
        await repo.reserve(scope, { purpose: "tutor", amountCents: 1, requestId: `other-${blockerState}`, requestFamily: null });
      }

      // Root tutor was not_sent, but nested retrieval reservation is unresolved/charged -> must fail closed.
      expect(await repo.isParentNotSent(scope, turnId)).toBe(false);
    },
  );

  it("blocks isParentNotSent when root <turnId> is unresolved and authorizes once both root and nested retrieval are not_sent", async () => {
    const h = turnFamilyLedgerHarness();
    const repo = createOpeningBudgetRepository(h.sql, { envCapCents: 100 });
    const turnId = "study-turn:unsent-both";
    const retrievalId = `retrieval:${turnId}`;
    const nestedRetrievalId = `retrieval:retrieval:${turnId}`;

    const tutor = await repo.reserve(scope, {
      purpose: "tutor",
      amountCents: 5,
      requestId: "tutor-unsent-both",
      requestFamily: null,
      parentBudget: { id: turnId },
    });
    const nestedEmb = await repo.reserve(scope, {
      purpose: "material-embedding",
      amountCents: 1,
      requestId: "emb-unsent-nested",
      requestFamily: null,
      parentBudget: { id: nestedRetrievalId },
    });

    // Release only retrievalId / nestedRetrievalId while root <turnId> is still reserved.
    await repo.release(scope, nestedEmb.requestId, "not_sent");
    expect(await repo.isParentNotSent(scope, retrievalId)).toBe(false);
    expect(await repo.isParentNotSent(scope, nestedRetrievalId)).toBe(false);
    expect(await repo.isParentNotSent(scope, turnId)).toBe(false);

    // Once root <turnId> is also released not_sent, the whole family is confirmed unsent.
    await repo.release(scope, tutor.requestId, "not_sent");
    expect(await repo.isParentNotSent(scope, turnId)).toBe(true);
    expect(await repo.isParentNotSent(scope, nestedRetrievalId)).toBe(true);
  });
});
