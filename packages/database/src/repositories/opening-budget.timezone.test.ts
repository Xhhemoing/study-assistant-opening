import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningBudgetRepository } from "./opening-budget";

/**
 * PR-B: opening-budget reads planning_settings.timeZone directly. An invalid stored
 * zone must fail the reserve explicitly (RangeError naming the zone) without
 * inserting a reservation, and must not affect another workspace.
 */
const wsBad = "11111111-1111-4111-8111-111111111111";
const wsOk = "22222222-2222-4222-8222-222222222222";
const owner = "33333333-3333-4333-8333-333333333333";
const zones: Record<string, string> = { [wsBad]: "Mars/Olympus_Mons", [wsOk]: "Asia/Shanghai" };

function fakeSql() {
  const inserts: string[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?");
    const ws = values.find((v) => v === wsBad || v === wsOk) as string | undefined;
    if (q.includes("FROM workspaces")) return Promise.resolve([{ id: ws }]);
    if (q.includes("FROM workspace_preferences")) {
      return Promise.resolve([{ ai_settings: null, planning_settings: { timeZone: zones[ws!] } }]);
    }
    if (q.includes("INSERT INTO opening_budget_reservations")) {
      inserts.push(ws!);
      return Promise.resolve([{
        id: "44444444-4444-4444-8444-444444444444", workspace_id: ws, purpose: "tutor", amount_cents: 1,
        request_id: `req-${ws}`, state: "reserved", model_snapshot: null,
        created_at: new Date("2026-10-12T00:00:00Z"), updated_at: new Date("2026-10-12T00:00:00Z"),
      }]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql & { begin: unknown; json: unknown };
  sql.begin = (cb: (tx: unknown) => unknown) => cb(sql);
  sql.json = (v: unknown) => v;
  return { sql: sql as unknown as Sql, inserts };
}

describe("opening-budget planning time zone (PR-B)", () => {
  it("invalid stored zone -> RangeError, no reservation; other workspace unaffected", async () => {
    const { sql, inserts } = fakeSql();
    const repo = createOpeningBudgetRepository(sql, { envCapCents: 1000 });
    await expect(repo.reserve({ workspaceId: wsBad, ownerUserId: owner }, { purpose: "tutor", requestId: "req-bad-0001", amountCents: 1 }))
      .rejects.toThrow(/invalid timeZone: Mars\/Olympus_Mons/);
    expect(inserts).toEqual([]);
    await repo.reserve({ workspaceId: wsOk, ownerUserId: owner }, { purpose: "tutor", requestId: "req-ok-00001", amountCents: 1 });
    expect(inserts).toEqual([wsOk]);
  });
});
