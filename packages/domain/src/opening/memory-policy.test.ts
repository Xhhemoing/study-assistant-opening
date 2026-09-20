import { expect, it, describe } from "vitest";
import { isMemoryEligible, memoriesForContext, memoriesForReview } from "./memory-policy";
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

describe("isMemoryEligible", () => {
  it("never treats an expired state or candidate as a fact", () => {
    expect(isMemoryEligible(base, "2026-09-12T10:00:00Z")).toBe(false);
    expect(
      isMemoryEligible(
        { ...base, kind: "temporary", expiresAt: "2026-09-12T09:00:00Z" },
        "2026-09-12T10:00:00Z",
      ),
    ).toBe(false);
  });

  it("allows confirmed active and unexpired temporary only", () => {
    expect(
      isMemoryEligible(
        { ...base, kind: "confirmed", status: "active" },
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
        },
        "2026-09-12T10:00:00Z",
      ),
    ).toBe(true);
    expect(
      isMemoryEligible(
        { ...base, kind: "confirmed", status: "rejected" },
        "2026-09-12T10:00:00Z",
      ),
    ).toBe(false);
  });
});

describe("context vs review assembly", () => {
  it("puts candidates in review only; confirmed/temporary in context", () => {
    const confirmed = { ...base, kind: "confirmed" as const, text: "fact" };
    const candidate = { ...base, id: "00000000-0000-4000-8000-000000000003", text: "pending" };
    const items = [confirmed, candidate];
    expect(memoriesForContext(items, "2026-09-12T10:00:00Z").map((m) => m.text)).toEqual(["fact"]);
    expect(memoriesForReview(items).map((m) => m.text)).toEqual(["pending"]);
  });
});
