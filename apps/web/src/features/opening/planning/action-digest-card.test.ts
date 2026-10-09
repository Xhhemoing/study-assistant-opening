import { describe, expect, it } from "vitest";
import {
  digestSurfacesPendingOnly,
  emptyActionDigest,
  reduceActionDigestCard,
} from "./action-digest-card";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("action-digest-card helpers", () => {
  it("starts empty and only surfaces pending primary rows", () => {
    expect(emptyActionDigest()).toEqual({ primary: [], pendingConfirmationCount: 0 });
    expect(
      digestSurfacesPendingOnly({
        primary: [
          {
            id: id(1),
            dedupeKey: "k",
            title: "作业",
            minutes: 30,
            dueAt: null,
            priority: 1,
            sourceIds: [id(2)],
            status: "pending",
            needsConfirmation: true,
          },
        ],
        pendingConfirmationCount: 1,
      }),
    ).toBe(true);
  });

  it("reduce keeps digest on decide failure", () => {
    const digest = {
      primary: [
        {
          id: id(1),
          dedupeKey: "k",
          title: "作业",
          minutes: 30,
          dueAt: null,
          priority: 1,
          sourceIds: [id(2)],
          status: "pending" as const,
          needsConfirmation: true,
        },
      ],
      pendingConfirmationCount: 1,
    };
    const next = reduceActionDigestCard(
      { digest, error: "", loading: false },
      { type: "decide_fail", message: "网络错误" },
    );
    expect(next.digest).toEqual(digest);
    expect(next.error).toBe("网络错误");
  });
});
