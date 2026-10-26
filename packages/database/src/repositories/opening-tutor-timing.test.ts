import type { Sql } from "postgres";
import { expect, it, vi } from "vitest";
import { recordOpeningTutorTiming } from "./opening-tutor-timing";

it.each([
  { observedAt: "not-a-time" }, { durationMs: -1 }, { durationMs: 1.5 },
  { durationMs: Infinity }, { durationMs: 2_147_483_648 },
])("rejects an invalid timing observation before persistence: %j", async patch => {
  const begin = vi.fn();
  await expect(recordOpeningTutorTiming({ begin } as unknown as Sql,
    { workspaceId: "workspace", ownerUserId: "owner" },
    { jobId: "job", executionId: "execution", claimToken: "lease", kind: "tutor_first_text", observedAt: new Date(), ...patch },
  )).rejects.toThrow("invalid tutor timing");
  expect(begin).not.toHaveBeenCalled();
});
