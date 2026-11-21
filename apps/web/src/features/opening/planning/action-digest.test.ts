// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ActionCandidate } from "@aistudy/contracts";
import { ActionDigest, confirmationCandidates } from "./action-digest";
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

it.each([true, false])("renders only focused actions when the digest has a backlog (focused=%s)", async hasFocusedAction => {
  const focused: ActionCandidate = {
    id: id(1), dedupeKey: "homework", title: "核对作业安排", minutes: 30,
    dueAt: null, priority: 1, sourceIds: [], status: "pending", needsConfirmation: true,
  };
  const api = {
    getActionDigest: vi.fn().mockResolvedValue({
      primary: hasFocusedAction ? [focused] : [],
      pendingConfirmationCount: 8,
    }),
    decideActionDigest: vi.fn(),
  };
  const host = document.createElement("div");
  const root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => root.render(createElement(ActionDigest, { api })));
    expect(host.textContent).not.toMatch(/另有\s+\d+\s+项待确认/u);
    if (hasFocusedAction) {
      expect(host.querySelector('[aria-label="优先行动"]')?.textContent).toContain(focused.title);
      expect([...host.querySelectorAll("button")].map(button => button.textContent)).toEqual(["接受", "修改", "拒绝", "查看依据"]);
    } else {
      expect(host.querySelector("section")).toBeNull();
    }
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
