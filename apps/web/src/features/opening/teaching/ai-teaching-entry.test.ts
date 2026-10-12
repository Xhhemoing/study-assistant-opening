/**
 * J1 / G8: lock the "AI 主讲" entry path (Today → teaching activity) so the
 * notes surface does not degrade it into read-materials / take-notes only.
 * Gating on 07862cf: dual flag (OPENING_TEACHING_LOOP && _WORKSPACE). PR-H
 * (e22ef8f) replaces this with server capabilities; then swap the gate input,
 * the expectations below stay.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openingNavigation } from "../shell/navigation";
import { TeachingActivityEmpty } from "./activity-panel";
import { TeachingLoopTrialEmpty } from "./teaching-loop-trial-empty";
import { resolveTeachingLoopTrialGate } from "./teaching-loop-trial";

const webSrc = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(webSrc, p), "utf8");

describe("AI 主讲 entry path", () => {
  it("Today is the first core entry and notes is a separate core entry after the assistant", () => {
    const core = openingNavigation().filter((i) => i.group === "core").map((i) => i.href);
    expect(core[0]).toBe("/opening/today");
    expect(core).toContain("/opening/library");
    expect(core.indexOf("/opening/library")).toBeGreaterThan(core.indexOf("/opening/today"));
  });

  it("/opening/today renders TodayDashboard (the teaching entry host)", () => {
    const page = read("app/(opening)/opening/today/page.tsx");
    expect(page).toMatch(/<TodayDashboard\b/);
  });

  it("Today selects the teaching continue entry when the trial gate is open, honest empty otherwise", () => {
    const dashboard = read("features/opening/planning/today-dashboard.tsx");
    expect(dashboard).toMatch(/teachingLoopTrialEnabled \? \(\s*<TeachingContinueEntry/);
    expect(dashboard).toMatch(/<TeachingLoopTrialEmpty/);
    expect(dashboard).toMatch(/<TeachingActivityEmpty/);
    expect(dashboard).not.toMatch(/\/opening\/library/);
  });

  it("gate open (both flags) → trial entry; any flag off → closed", () => {
    expect(resolveTeachingLoopTrialGate({ OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_WORKSPACE: "1" }).trialEnabled).toBe(true);
    expect(resolveTeachingLoopTrialGate({ OPENING_TEACHING_LOOP: "1" }).trialEnabled).toBe(false);
    expect(resolveTeachingLoopTrialGate({}).trialEnabled).toBe(false);
  });

  it("no activity yet → primary CTA starts teaching; notes/materials are not the fallback", () => {
    const html = renderToStaticMarkup(createElement(TeachingActivityEmpty, { onStart: () => undefined }));
    expect(html).toContain("开始学习");
    expect(html).toContain("AI 主讲");
    expect(html).not.toContain("/opening/library");
  });

  it("gate closed → honest 'AI 主讲试运行未开启', not redirected into notes/materials", () => {
    const html = renderToStaticMarkup(createElement(TeachingLoopTrialEmpty, { loopEnabled: false, workspaceEnabled: true }));
    expect(html).toContain("AI 主讲试运行未开启");
    expect(html).toContain('data-loop-enabled="false"');
    expect(html).not.toContain("/opening/library");
  });

  it("notes entry routes stay inside the Opening shell", () => {
    expect(read("app/(opening)/opening/library/[id]/page.tsx")).toMatch(/basePath="\/opening\/library"/);
    expect(read("app/(opening)/opening/library/new/page.tsx")).toMatch(/basePath="\/opening\/library"/);
  });
});
