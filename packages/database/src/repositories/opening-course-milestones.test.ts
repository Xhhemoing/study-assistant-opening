import { describe, expect, it } from "vitest";
import { mergeCourseGoal } from "./opening-course-milestones";
import type { CourseMilestoneUpdate } from "@aistudy/contracts";

const now = "2026-10-16T12:00:00.000Z";
const goal = { targetDate: null, weeklyMinutes: 120 };
const milestone: CourseMilestoneUpdate = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "矩阵乘法",
  successCriteria: "独立完成两道新题，解释维数。", targetDate: null, evidenceRefs: [] };
const create = () => mergeCourseGoal(goal, { ...goal, milestones: [milestone] }, 0, now);

describe("course outcome version ownership", () => {
  it("preserves legacy shape until milestones are used", () => {
    expect(mergeCourseGoal(goal, goal, undefined, now)).toEqual(goal);
    expect(mergeCourseGoal(goal, goal, 0, now)).toEqual({ ...goal, revision: 1 });
    expect(create()).toMatchObject({ revision: 1, milestones: [{ revision: 1, status: "planned", confirmedAt: null, history: [] }] });
  });
  it("preserves milestones on legacy patches and invalidates stale new clients", () => {
    const saved = create();
    const legacy = mergeCourseGoal(saved, { ...goal, weeklyMinutes: 180 }, undefined, now);
    expect(legacy).toMatchObject({ revision: 2, weeklyMinutes: 180, milestones: saved.milestones });
    expect(() => mergeCourseGoal(legacy, { ...goal, milestones: [milestone] }, 1, now)).toThrow(/已更新/);
  });
  it("requires a separate learner action to confirm a saved standard", () => {
    expect(() => mergeCourseGoal(goal, { ...goal, milestones: [{ ...milestone, confirm: true }] }, 0, now)).toThrow(/先保存/);
    const saved = create();
    const confirmed = mergeCourseGoal(saved, { ...goal, milestones: [{ ...milestone, confirm: true }] }, 1, now);
    expect(confirmed.milestones?.[0]).toMatchObject({ revision: 2, status: "confirmed_by_learner", confirmedAt: now,
      history: [{ revision: 1, status: "planned" }] });
  });
  it("resets changed criteria but preserves all previous evidence and confirmation versions", () => {
    const ref = { kind: "observation" as const, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const value = { ...milestone, evidenceRefs: [ref] };
    const saved = mergeCourseGoal(undefined, { ...goal, milestones: [value] }, 0, now);
    const confirmed = mergeCourseGoal(saved, { ...goal, milestones: [{ ...value, confirm: true }] }, 1, now);
    const changed = mergeCourseGoal(confirmed, { ...goal, milestones: [{ ...value, successCriteria: "隔一周完成迁移题", evidenceRefs: [] }] }, 2, now);
    expect(changed.milestones?.[0]).toMatchObject({ revision: 3, status: "planned", confirmedAt: null, evidenceRefs: [],
      history: [{ revision: 1, evidenceRefs: [ref] }, { revision: 2, evidenceRefs: [ref], confirmedAt: now }] });
    expect(() => mergeCourseGoal(confirmed, { ...goal, milestones: [{ ...value, successCriteria: "新标准", confirm: true }] }, 2, now)).toThrow(/先保存/);
  });
  it("merges by id and does not erase saved outcomes through omission or an empty change list", () => {
    const saved = create();
    expect(mergeCourseGoal(saved, { ...goal, milestones: [] }, 1, now).milestones).toEqual(saved.milestones);
    const second = { ...milestone, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    expect(mergeCourseGoal(saved, { ...goal, milestones: [second] }, 1, now).milestones).toHaveLength(2);
  });
  it("reopens confirmed outcomes and keeps the bounded history without truncation", () => {
    const saved = create();
    const confirmed = mergeCourseGoal(saved, { ...goal, milestones: [{ ...milestone, confirm: true }] }, 1, now);
    const reopened = mergeCourseGoal(confirmed, { ...goal, milestones: [{ ...milestone, confirm: false }] }, 2, now);
    expect(reopened.milestones?.[0]).toMatchObject({ status: "planned", confirmedAt: null, revision: 3 });
    const item = reopened.milestones![0]!;
    const { history: _history, ...version } = item;
    expect(() => mergeCourseGoal({ ...reopened, milestones: [{ ...item, history: Array(50).fill(version) }] },
      { ...goal, milestones: [{ ...milestone, title: "new" }] }, 3, now)).toThrow(/50次/);
  });
});
