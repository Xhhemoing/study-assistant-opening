import { expect, it, describe } from "vitest";
import { isMemoryEligible, memoriesForContext, memoriesForReview, instructionWithMemories } from "./memory-policy";
import type { MemoryItem } from "@aistudy/contracts";

const base: MemoryItem = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  courseId: null,
  kind: "candidate",
  text: "喜欢提示",
  sourceTurnIds: [],
  version: 1,
  expiresAt: null,
  status: "active",
  createdAt: "2026-09-12T08:00:00.000Z",
  updatedAt: "2026-09-12T08:00:00.000Z",
};

const sourced = "00000000-0000-4000-8000-000000000010";

describe("isMemoryEligible", () => {
  it("never treats an expired state or candidate as a fact", () => {
    expect(isMemoryEligible(base, "2026-09-12T10:00:00Z")).toBe(false);
    expect(
      isMemoryEligible(
        { ...base, kind: "temporary", expiresAt: "2026-09-12T09:00:00Z", sourceTurnIds: [sourced] },
        "2026-09-12T10:00:00Z",
      ),
    ).toBe(false);
  });

  it("allows confirmed active and unexpired temporary only when sourced", () => {
    expect(
      isMemoryEligible(
        { ...base, kind: "confirmed", status: "active", sourceTurnIds: [sourced] },
        "2026-09-12T10:00:00Z",
      ),
    ).toBe(true);
    expect(
      isMemoryEligible(
        {
          ...base,
          kind: "temporary",
          expiresAt: "2026-09-12T11:00:00Z",
          status: "active",
          sourceTurnIds: [sourced],
        },
        "2026-09-12T10:00:00Z",
      ),
    ).toBe(true);
    expect(
      isMemoryEligible(
        { ...base, kind: "confirmed", status: "rejected", sourceTurnIds: [sourced] },
        "2026-09-12T10:00:00Z",
      ),
    ).toBe(false);
  });

  it("keeps source-less confirmed and temporary memories out of model context", () => {
    expect(
      isMemoryEligible(
        { ...base, kind: "confirmed", status: "active", sourceTurnIds: [] },
        "2026-09-12T10:00:00Z",
      ),
    ).toBe(false);
    expect(
      isMemoryEligible(
        {
          ...base,
          kind: "temporary",
          expiresAt: "2026-09-12T11:00:00Z",
          status: "active",
          sourceTurnIds: [],
        },
        "2026-09-12T10:00:00Z",
      ),
    ).toBe(false);
  });
});

describe("context vs review assembly", () => {
  it("puts candidates in review only; sourced confirmed/temporary in context", () => {
    const confirmed = {
      ...base,
      kind: "confirmed" as const,
      text: "fact",
      sourceTurnIds: [sourced],
    };
    const unsourced = {
      ...base,
      id: "00000000-0000-4000-8000-000000000004",
      kind: "confirmed" as const,
      text: "manual-only",
      sourceTurnIds: [],
    };
    const candidate = { ...base, id: "00000000-0000-4000-8000-000000000003", text: "pending" };
    const items = [confirmed, unsourced, candidate];
    expect(memoriesForContext(items, "2026-09-12T10:00:00Z").map((m) => m.text)).toEqual(["fact"]);
    expect(memoriesForReview(items).map((m) => m.text)).toEqual(["pending"]);
    const instruction = instructionWithMemories("解释概念", items, "2026-09-12T10:00:00Z");
    expect(instruction).toContain("fact");
    expect(instruction).not.toContain("pending");
    expect(instruction).not.toContain("manual-only");
  });
});
