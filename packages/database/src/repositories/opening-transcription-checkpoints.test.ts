import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import type { OpeningBudgetRepository } from "./opening-budget";
import { createOpeningTranscriptionCheckpointsRepository } from "./opening-transcription-checkpoints";

const scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
};
const reservationId = "33333333-3333-4333-8333-333333333333";
const chunk = {
  jobId: "44444444-4444-4444-8444-444444444444",
  sourceId: "55555555-5555-4555-8555-555555555555",
  sourceVersion: 1,
  privacyEpoch: 0,
  index: 0,
  offsetMs: 0,
  durationMs: 1000,
};
const key = `transcribe:${chunk.jobId}:${chunk.index}`;
const output = {
  text: JSON.stringify({ segments: [{ startMs: 0, endMs: 900, text: "spoken" }] }),
  citedChunkIds: [],
  candidates: [],
  requestId: null,
  inputTokens: 10,
  outputTokens: 10,
};

function mockSql(opts: {
  storedResult: Record<string, unknown>;
  reservationRow: {
    state: string;
    pending_reconcile_cents: number;
    amount_cents: number;
    result_ref: string | null;
    settlement_cost_basis: string | null;
    outcome_unknown_at: Date | null;
    reconciled_at?: Date | null;
  };
  onSettleAttach?: () => void;
}) {
  let row = { reconciled_at: null, ...opts.reservationRow };
  const tag = async (strings: TemplateStringsArray, ...bindings: unknown[]): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM workspaces w") && q.includes("FOR SHARE")) return [{ id: chunk.jobId }];
    if (q.includes("SELECT payload, result, key FROM opening_jobs")) {
      return [{ payload: { ...chunk, receiptKind: "transcribe-chunk" }, result: opts.storedResult, key }];
    }
    if (q.includes("AS matches")) return [{ matches: true }];
    if (q.includes("UPDATE opening_budget_reservations b") && q.includes("SET result_ref=")) {
      const expectedSettlementBasis = opts.storedResult.costBasis ?? undefined;
      const allowMedia = expectedSettlementBasis === undefined || expectedSettlementBasis === "media_usage_upper_bound";
      const allowUsage = expectedSettlementBasis === undefined || expectedSettlementBasis === "usage_pricing";
      const allowVendor = expectedSettlementBasis !== "usage_pricing";
      const canAttach = row.state === "completed"
        && row.pending_reconcile_cents === 0
        && row.outcome_unknown_at === null
        && row.result_ref === null
        && (row.reconciled_at === null || row.settlement_cost_basis !== null)
        && ((row.amount_cents === opts.storedResult.settledCents && (
          (allowMedia && row.settlement_cost_basis === "media_usage_upper_bound")
          || (allowUsage && row.settlement_cost_basis === "usage_pricing")
        )) || (allowVendor && row.settlement_cost_basis === "vendor_receipt"));
      if (canAttach) {
        row = { ...row, result_ref: key };
        opts.onSettleAttach?.();
        return [{ id: reservationId }];
      }
      return [];
    }
    if (q.includes("SELECT state, pending_reconcile_cents, amount_cents, result_ref, settlement_cost_basis, outcome_unknown_at")) {
      return [row];
    }
    void bindings;
    return [];
  };
  const sql = Object.assign(
    ((strings: TemplateStringsArray, ...bindings: unknown[]) => {
      if (strings[0]!.startsWith("b.id=")) return { __frag: true };
      return tag(strings, ...bindings);
    }) as unknown as Sql,
    {
      begin: async (run: (txArg: Sql) => Promise<unknown>) => run(sql),
      json: (v: unknown) => v,
    },
  );
  return {
    sql,
    setRow: (next: typeof row) => { row = { ...row, ...next }; },
    getRow: () => row,
  };
}

describe("opening transcription checkpoints costBasis compatibility", () => {
  it.each(["usage_pricing", "media_usage_upper_bound", "vendor_receipt"] as const)(
    "accepts legacy checkpoint without costBasis when reservation is already settled as %s",
    async (basis) => {
      const db = mockSql({
        storedResult: { output, reservationId, settledCents: 1 },
        reservationRow: {
          state: "completed",
          pending_reconcile_cents: 0,
          amount_cents: basis === "vendor_receipt" ? 3 : 1,
          result_ref: key,
          settlement_cost_basis: basis,
          outcome_unknown_at: null,
        },
      });
      const settle = vi.fn();
      const repo = createOpeningTranscriptionCheckpointsRepository(db.sql);
      await expect(repo.recover(scope, chunk, { settle, markUnknown: vi.fn() } as unknown as OpeningBudgetRepository)).resolves.toEqual(output);
      expect(settle).not.toHaveBeenCalled();
    },
  );

  it("repairs missing result_ref on a legacy checkpoint without costBasis when already settled as usage_pricing or null costBasis", async () => {
    const db = mockSql({
      storedResult: { output, reservationId, settledCents: 1, costBasis: null },
      reservationRow: {
        state: "completed",
        pending_reconcile_cents: 0,
        amount_cents: 1,
        result_ref: null,
        settlement_cost_basis: "usage_pricing",
        outcome_unknown_at: null,
      },
    });
    const settle = vi.fn();
    const repo = createOpeningTranscriptionCheckpointsRepository(db.sql);
    await expect(repo.recover(scope, chunk, { settle, markUnknown: vi.fn() } as unknown as OpeningBudgetRepository)).resolves.toEqual(output);
    expect(db.getRow().result_ref).toBe(key);
    expect(settle).not.toHaveBeenCalled();
  });

  it("settles an unsettled legacy checkpoint without costBasis using media_usage_upper_bound", async () => {
    const db = mockSql({
      storedResult: { output, reservationId, settledCents: 1 },
      reservationRow: {
        state: "completed",
        pending_reconcile_cents: 100,
        amount_cents: 100,
        result_ref: null,
        settlement_cost_basis: null,
        outcome_unknown_at: new Date(),
        reconciled_at: new Date(),
      },
    });
    const settle = vi.fn(async () => {
      db.setRow({ state: "completed", pending_reconcile_cents: 0, amount_cents: 1, result_ref: key, settlement_cost_basis: "media_usage_upper_bound", outcome_unknown_at: null });
      return {} as never;
    });
    const repo = createOpeningTranscriptionCheckpointsRepository(db.sql);
    await expect(repo.recover(scope, chunk, { settle, markUnknown: vi.fn() } as unknown as OpeningBudgetRepository)).resolves.toEqual(output);
    expect(settle).toHaveBeenCalledExactlyOnceWith(scope, reservationId, 1, { resultRef: key, costBasis: "media_usage_upper_bound" });
  });

  it("enforces explicit costBasis when stored on the checkpoint", async () => {
    const db = mockSql({
      storedResult: { output, reservationId, settledCents: 1, costBasis: "media_usage_upper_bound" },
      reservationRow: {
        state: "completed",
        pending_reconcile_cents: 0,
        amount_cents: 1,
        result_ref: key,
        settlement_cost_basis: "usage_pricing",
        outcome_unknown_at: null,
      },
    });
    const settle = vi.fn(async () => { throw new Error("NOT_FOUND"); });
    const repo = createOpeningTranscriptionCheckpointsRepository(db.sql);
    await expect(repo.recover(scope, chunk, { settle, markUnknown: vi.fn() } as unknown as OpeningBudgetRepository)).rejects.toThrow("NOT_FOUND");
    expect(settle).toHaveBeenCalledOnce();

    const usageDb = mockSql({
      storedResult: { output, reservationId, settledCents: 1, costBasis: "usage_pricing" },
      reservationRow: {
        state: "completed",
        pending_reconcile_cents: 0,
        amount_cents: 1,
        result_ref: key,
        settlement_cost_basis: "media_usage_upper_bound",
        outcome_unknown_at: null,
      },
    });
    const usageRepo = createOpeningTranscriptionCheckpointsRepository(usageDb.sql);
    await expect(usageRepo.recover(scope, chunk, { settle, markUnknown: vi.fn() } as unknown as OpeningBudgetRepository)).rejects.toThrow("NOT_FOUND");
  });
});
