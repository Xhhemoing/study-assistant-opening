import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { OpeningScope } from "./opening-sources";
export class OpeningBudgetError extends Error { constructor(readonly code: "CONFLICT" | "NOT_FOUND" | "BUDGET_EXCEEDED", message: string) { super(message); } }
const CAP = 100000;
export function createOpeningBudgetRepository(sql: Sql) { return {
  async reserve(scope: OpeningScope, input: { purpose: string; amountCents: number; requestId: string }) { if (input.amountCents <= 0) throw new OpeningBudgetError("CONFLICT", "amount must be positive"); const rows = await sql`INSERT INTO opening_budget_reservations (id,workspace_id,purpose,amount_cents,request_id) SELECT ${randomUUID()},${scope.workspaceId},${input.purpose},${input.amountCents},${input.requestId} WHERE ${input.amountCents}+COALESCE((SELECT sum(amount_cents) FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId} AND state='reserved'),0)<=${CAP} ON CONFLICT (request_id) DO NOTHING RETURNING *`; if (rows.length) return rows[0]; const existing = await sql`SELECT * FROM opening_budget_reservations WHERE request_id=${input.requestId}`; if (existing.length) return existing[0]; throw new OpeningBudgetError("BUDGET_EXCEEDED", "budget exceeded"); },
  async release(requestId: string) { return this.change(requestId, "released"); }, async complete(requestId: string) { return this.change(requestId, "completed"); },
  async change(requestId: string, state: "released" | "completed") { const rows = await sql`UPDATE opening_budget_reservations SET state=${state},updated_at=now() WHERE request_id=${requestId} RETURNING *`; if (!rows.length) throw new OpeningBudgetError("NOT_FOUND", "reservation not found"); return rows[0]; },
}; }
