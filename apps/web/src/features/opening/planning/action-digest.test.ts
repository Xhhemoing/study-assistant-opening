import { describe, expect, it } from "vitest";
import { confirmationCandidates } from "./action-digest";
import { digestSurfacesPendingOnly, emptyActionDigest } from "./action-digest-card";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("action-digest U04 surface helpers", () => {
  it("keeps primary pending-only and concentrates confirmation rows", () => {
    expect(emptyActionDigest()).toEqual({ primary: [], pendingConfirmationCount: 0 });
    const digest = {
      primary: [
        {
          id: id(1),
          dedupeKey: "a",
          title: "作业",
          minutes: 30,
          dueAt: null,
          priority: 1,
          sourceIds: [id(2)],
          status: "pending" as const,
          needsConfirmation: true,
        },
        {
          id: id(3),
          dedupeKey: "b",
          title: "复习",
          minutes: 20,
          dueAt: null,
          priority: 2,
          sourceIds: [],
          status: "pending" as const,
          needsConfirmation: false,
        },
      ],
      pendingConfirmationCount: 1,
    };
    expect(digestSurfacesPendingOnly(digest)).toBe(true);
    expect(confirmationCandidates(digest)).toHaveLength(1);
    expect(confirmationCandidates(digest)[0]?.title).toBe("作业");
  });
});
