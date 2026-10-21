// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusResult } from "@aistudy/contracts";
import { ReasonDrawer } from "./reason-drawer";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
});

const status: StatusResult = {
  syllabusPointId: "11111111-1111-4111-8111-111111111101",
  status: "weak",
  summaryMetrics: [],
  reasonCodes: ["recent-failure", "low-confidence"],
  recommendedActions: [{ code: "variant", label: "做一道变式题", estimatedMinutes: 10 }],
  evidenceSnapshotId: "snap-reason",
  strategyVersion: "assess-1",
  modelVersion: "rules-1",
  computedAt: "2026-08-03T08:00:00.000Z",
};

describe("reason drawer", () => {
  it("shows reasons, improvement actions, and correction entry in the portalled dialog", async () => {
    const onClose = vi.fn();
    await act(async () => root.render(createElement(ReasonDrawer, {
      open: true,
      onClose,
      onCorrection: vi.fn(async () => undefined),
      status,
    })));

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(container.contains(dialog)).toBe(false);
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    expect(dialog!.textContent).toContain("为什么");
    expect(dialog!.textContent).toContain("最近一次作答没有答对");
    expect(dialog!.textContent).toContain("做一道变式题");
    expect(dialog!.textContent).toContain("判断不准");
    expect(dialog!.querySelector("textarea")).not.toBeNull();
    await act(async () => (dialog!.querySelector('[aria-label="关闭抽屉"]') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledOnce();
  });
});
