import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { helpExposureSchema } from "@aistudy/contracts";
import { listDeliveredHelpByActivity } from "./opening-learning-help";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("opening-learning-help persist surface (V2-13 T12)", () => {
  it.each([null, 1, 2, 3, 4])("reads the same nullable hint stage %s and initiator through HelpExposure", async hintStage => {
    const id = "11111111-1111-4111-8111-111111111111";
    const sql = vi.fn(async () => [{ id, session_id: id, turn_id: id, problem_id: null, kind: "hint", level: "hinted",
      hint_stage: hintStage, initiated_by: hintStage === null ? null : "user", created_at: new Date(), history_revision: 1 }]);
    const [help] = await listDeliveredHelpByActivity(sql as unknown as Sql, { workspaceId: id, ownerUserId: id }, id);
    expect(help).toMatchObject({ hintStage, initiatedBy: hintStage === null ? null : "user" });
    expect(helpExposureSchema.parse(help)).toEqual(help);
    expect(helpExposureSchema.safeParse({ ...help, hintStage: 5 }).success).toBe(false);
    expect(helpExposureSchema.safeParse({ ...help, initiatedBy: "worker" }).success).toBe(false);
  });
  it("insert SQL includes kind, activity_id, item_version_id", () => {
    const src = readFileSync(resolve(__dirname, "opening-learning-help.ts"), "utf8");
    expect(src).toMatch(/kind,activity_id,item_version_id/);
    expect(src).toMatch(/input\.kind/);
    expect(src).toMatch(/help exposure requires kind/);
  });
});
