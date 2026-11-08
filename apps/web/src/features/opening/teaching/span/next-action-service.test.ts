import { beforeEach, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createSpanNextActionService } from "./next-action-service";
const dependency = vi.hoisted(() => ({ next: vi.fn() }));
vi.mock("@aistudy/database", async importOriginal => ({ ...await importOriginal<object>(), createOpeningSpanTutorNextRepository: () => dependency }));
const id = "00000000-0000-4000-8000-000000000001", courseId = "00000000-0000-4000-8000-000000000002";
const scope = { workspaceId: id, ownerUserId: id }, body = { activityId: id, expectedRevision: 1, observationId: null, clientKey: "stable-span-next" };
const session = { activityId: id, sessionId: id, courseId, retestId: null };
beforeEach(() => { vi.resetAllMocks(); });
it("returns an actual lesson route for a correction activity, preserving retest identity on a replay", async () => {
  dependency.next.mockResolvedValue({ kind: "ready", session, replayed: false, decision: { activityKind: "targeted_explain" } });
  expect(await createSpanNextActionService({} as Sql).next(scope, body)).toMatchObject({ kind: "ready", label: "开始针对性讲解",
    href: `/opening/courses/${courseId}/study/span?lesson=${id}`, activityId: id, sessionId: id });
  dependency.next.mockResolvedValue({ kind: "ready", session: { ...session, retestId: id }, replayed: true, decision: null });
  expect(await createSpanNextActionService({} as Sql).next(scope, body)).toMatchObject({ href: `/opening/courses/${courseId}/study/span?lesson=${id}&retest=${id}`, resumed: true });
});
it.each(["unknown_evidence", "source_unavailable", "cancelled", "expired"])("preserves an actionable %s choice instead of announcing an activity", async reason => {
  dependency.next.mockResolvedValue({ kind: "choice", reason, courseId, originSession: session });
  expect(await createSpanNextActionService({} as Sql).next(scope, body)).toMatchObject({ kind: "choice", reason,
    primary: { href: reason === "source_unavailable" ? `/opening/courses/${courseId}` : `/opening/courses/${courseId}#course-learning-records` } });
});
it("explains the two-cycle limit and offers explicit method changes without announcing execution", async () => {
  dependency.next.mockResolvedValue({ kind: "choice", reason: "remediation_limit", courseId, originSession: session });
  const result = await createSpanNextActionService({} as Sql).next(scope, body);
  expect(result).toMatchObject({ kind: "choice", reason: "remediation_limit",
    primary: { label: "换讲法：回原活动选择串讲例题", href: `/opening/courses/${courseId}/study/span?lesson=${id}` },
    secondary: { label: "到课程路线重新选择", href: `/opening/courses/${courseId}?tab=units#course-learning-route` } });
  expect("message" in result && result.message).toContain("没有自动发第三轮题");
  expect(result).not.toHaveProperty("activityId");
  expect("message" in result && result.message).toContain("到课程路线重新选择");
  expect("message" in result && result.message).not.toContain("重新诊断");
});
it("offers actual ordinary practice after the unseen bank is unavailable without claiming new independent evidence", async () => {
  dependency.next.mockResolvedValue({ kind: "choice", reason: "unseen_unavailable", courseId, originSession: session });
  expect(await createSpanNextActionService({} as Sql).next(scope, body)).toMatchObject({ kind: "choice", reason: "unseen_unavailable",
    primary: { label: "继续普通练习（不作为未见题验证）", href: `/opening/courses/${courseId}/study?mode=practice&skillLabel=%E7%BA%BF%E6%80%A7%E7%BB%84%E5%90%88%E4%B8%8E+span&requirementKey=span%3Alinear-combination%3Av1` } });
});
it("points a stale derived receipt at the current owned origin and leaves its history accessible", async () => {
  const originId = "00000000-0000-4000-8000-000000000003";
  dependency.next.mockResolvedValue({ kind: "choice", reason: "evidence_changed", courseId,
    originSession: { ...session, activityId: originId }, historicalSession: session });
  expect(await createSpanNextActionService({} as Sql).next(scope, body)).toMatchObject({ kind: "choice", reason: "evidence_changed",
    primary: { href: `/opening/courses/${courseId}/study/span?lesson=${originId}` },
    secondary: { href: `/opening/courses/${courseId}/study/span?lesson=${id}` } });
  dependency.next.mockResolvedValue({ kind: "choice", reason: "evidence_changed", courseId, originSession: null, historicalSession: session });
  expect(await createSpanNextActionService({} as Sql).next(scope, body)).toMatchObject({ primary: { href: `/opening/courses/${courseId}#course-learning-records` } });
});
