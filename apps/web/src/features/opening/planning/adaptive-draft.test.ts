import { describe, expect, it } from "vitest";
import { uuidSchema } from "@aistudy/contracts";
import { freeMinutes, suggestionTaskId } from "./adaptive-draft";

describe("adaptive draft helpers", () => {
  it("derives a stable, valid task id per workspace and suggestion key", () => {
    const key = "planner:2026-09-14:weak_skill:course:0123abcd";
    const id = suggestionTaskId("11111111-1111-4111-8111-111111111111", key);
    expect(uuidSchema.safeParse(id).success).toBe(true);
    expect(suggestionTaskId("11111111-1111-4111-8111-111111111111", key)).toBe(id);
    expect(suggestionTaskId("22222222-2222-4222-8222-222222222222", key)).not.toBe(id);
  });

  it("counts only free time as capacity", () => {
    expect(freeMinutes([
      { start: "2026-09-14T00:00:00.000Z", end: "2026-09-14T01:30:00.000Z", kind: "free" },
      { start: "2026-09-14T01:30:00.000Z", end: "2026-09-14T02:15:00.000Z", kind: "class" },
      { start: "2026-09-14T02:15:00.000Z", end: "2026-09-14T02:40:30.000Z", kind: "free" },
    ])).toBe(115);
  });
});
