import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AssistantProposalRecord } from "@aistudy/contracts";
import { PlanProposalPreview } from "./proposal-panel";
const id = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002";
it("lets the learner inspect named before/after slots and unscheduled work before accepting", () => {
  const row: AssistantProposalRecord = { id, sourceTurnId: id, version: 0, status: "draft", createdAt: "2026-10-19T10:00:00Z", basisVersion: "v1", result: null,
    tool: { name: "propose_plan_change", arguments: { date: "2026-10-19", expectedAcceptedVersion: 1 } },
    prepared: { draftId: id, expectedBaseVersion: 1, expectedDraftVersion: 0, preview: { timeZone: "UTC", tasks: [{ id, title: "线性张成练习" }, { id: other, title: "复测错题" }],
      previousBlocks: [{ taskId: id, start: "2026-10-19T09:00:00Z", end: "2026-10-19T09:30:00Z", reason: "原安排" }],
      proposedBlocks: [{ taskId: id, start: "2026-10-19T11:00:00Z", end: "2026-10-19T11:30:00Z", reason: "补排" }], unscheduledTaskIds: [other] } } };
  const html = renderToStaticMarkup(createElement(PlanProposalPreview, { row }));
  for (const value of ["线性张成练习", "调整", "09:00", "11:00", "原安排", "草稿", "尚未排入", "复测错题", "UTC"]) expect(html).toContain(value);
  expect(renderToStaticMarkup(createElement(PlanProposalPreview, { row: { ...row, prepared: null } }))).toContain("计划预览不可用");
});
