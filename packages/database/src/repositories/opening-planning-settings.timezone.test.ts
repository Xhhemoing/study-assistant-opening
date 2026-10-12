import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { DEFAULT_OPENING_PLANNING_SETTINGS } from "@aistudy/contracts";
import { createOpeningPlanningSettingsRepository } from "./opening-planning-settings";
import { WorkspacePreferencesError } from "./preferences";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };

function fakeSql(stored: unknown) {
  const writes: string[] = [];
  const sql = ((strings: TemplateStringsArray) => {
    const q = strings.join("?");
    if (/INSERT INTO/.test(q)) writes.push(q);
    if (q.includes("planning_settings FROM workspaces")) return Promise.resolve([{ planning_settings: stored }]);
    return Promise.resolve([{ id: scope.workspaceId }]);
  }) as unknown as Sql & { begin: unknown; json: unknown };
  sql.begin = (cb: (tx: unknown) => unknown) => cb(sql);
  sql.json = (v: unknown) => v;
  return { sql: sql as unknown as Sql, writes };
}

describe("planning settings time zone (PR-B)", () => {
  it("rejects an invalid IANA zone on write without touching storage", async () => {
    const { sql, writes } = fakeSql(null);
    const repo = createOpeningPlanningSettingsRepository(sql);
    await expect(repo.set(scope, { ...DEFAULT_OPENING_PLANNING_SETTINGS, timeZone: "Mars/Olympus_Mons" }))
      .rejects.toBeInstanceOf(WorkspacePreferencesError);
    expect(writes).toEqual([]);
  });

  it("accepts a valid zone", async () => {
    const { sql, writes } = fakeSql(null);
    await createOpeningPlanningSettingsRepository(sql).set(scope, { ...DEFAULT_OPENING_PLANNING_SETTINGS, timeZone: "America/New_York" });
    expect(writes).toHaveLength(1);
  });

  it("an already-stored invalid zone is returned unchanged (no data rewrite) so callers fail loudly", async () => {
    const stored = { ...DEFAULT_OPENING_PLANNING_SETTINGS, timeZone: "Mars/Olympus_Mons" };
    const { sql, writes } = fakeSql(stored);
    const got = await createOpeningPlanningSettingsRepository(sql).get(scope);
    expect(got.settings?.timeZone).toBe("Mars/Olympus_Mons");
    expect(writes).toEqual([]);
  });
});
