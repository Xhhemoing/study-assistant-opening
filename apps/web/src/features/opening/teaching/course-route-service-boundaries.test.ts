import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createCourseRouteService } from "./course-route-service";

const methods = vi.hoisted(() => ({ read: vi.fn(), confirm: vi.fn(), start: vi.fn(), next: vi.fn(), schedule: vi.fn(),
  readTask: vi.fn(), verificationRead: vi.fn(), verificationConfirm: vi.fn() }));
vi.mock("@aistudy/database", () => ({
  createOpeningCourseRouteRepository: () => methods,
  createOpeningCourseRouteRetestRepository: () => methods,
  createOpeningCourseRouteVerificationRepository: () => ({ read: methods.verificationRead, confirm: methods.verificationConfirm }),
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sql = vi.fn() as unknown as Sql;
const base = { goalId: id(1), expectedGoalRevision: 1, clientKey: "route-boundary", minutes: 20 };
const next = { ...base, activityId: id(2), expectedPathVersion: 1, observationId: id(3) };
const confirm = { expectedRevisions: [], confirmScope: true, requirements: [{ id: id(4), stableSkillId: id(5), knowledgeNodeId: null,
  requirementKey: "arithmetic", title: "Arithmetic", position: 0, mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [],
  verification: { kind: "exact", status: "missing", exerciseKeys: [], rubric: null, missingReasons: [] }, origin: "confirmed" }] };
const verification = { goalId: id(1), expectedGoalRevision: 1, activityId: id(2), expectedContentVersion: 1,
  requirementId: id(4), expectedRequirementRevision: 1, itemVersionIds: [id(6)], confirmed: true };
// Inputs follow the existing public schemas; sentinel receipts deliberately test
// transparent forwarding only, not fabricated repository result contracts.
const cases = [
  { name: "read", method: methods.read, args: [id(2)], call: (s: ReturnType<typeof createCourseRouteService>, scope: {workspaceId:string;ownerUserId:string}, course: string) => s.read(scope, course, id(2)) },
  { name: "confirm", method: methods.confirm, args: [confirm], call: (s: ReturnType<typeof createCourseRouteService>, scope: {workspaceId:string;ownerUserId:string}, course: string) => s.confirm(scope, course, confirm) },
  { name: "start", method: methods.start, args: [{ ...base, requirementId: id(4), expectedRequirementRevision: 1 }], call: (s: ReturnType<typeof createCourseRouteService>, scope: {workspaceId:string;ownerUserId:string}, course: string) => s.start(scope, course, { ...base, requirementId: id(4), expectedRequirementRevision: 1 }) },
  { name: "next", method: methods.next, args: [next], call: (s: ReturnType<typeof createCourseRouteService>, scope: {workspaceId:string;ownerUserId:string}, course: string) => s.next(scope, course, next) },
  { name: "scheduleRetest", method: methods.schedule, args: [next], call: (s: ReturnType<typeof createCourseRouteService>, scope: {workspaceId:string;ownerUserId:string}, course: string) => s.scheduleRetest(scope, course, next) },
  { name: "readTask", method: methods.readTask, args: [id(7)], call: (s: ReturnType<typeof createCourseRouteService>, scope: {workspaceId:string;ownerUserId:string}, course: string) => s.readTask(scope, course, id(7)) },
  { name: "readVerification", method: methods.verificationRead, args: [id(2)], call: (s: ReturnType<typeof createCourseRouteService>, scope: {workspaceId:string;ownerUserId:string}, course: string) => s.readVerification(scope, course, id(2)) },
  { name: "confirmVerification", method: methods.verificationConfirm, args: [verification], call: (s: ReturnType<typeof createCourseRouteService>, scope: {workspaceId:string;ownerUserId:string}, course: string) => s.confirmVerification(scope, course, verification) },
];
afterEach(() => { vi.resetAllMocks(); });
for (const course of [id(30), id(31)]) for (const scope of [
  { workspaceId: id(40), ownerUserId: id(41) }, { workspaceId: id(42), ownerUserId: id(43) },
]) describe(`route forwarding course=${course} owner=${scope.ownerUserId}`, () => {
  it.each(cases)("preserves scope, course and result identity: $name", async ({ method, args, call }) => {
    const result = { sentinel: Symbol("repository receipt") };
    method.mockResolvedValue(result);
    expect(await call(createCourseRouteService(sql, {}), scope, course)).toBe(result);
    expect(method).toHaveBeenCalledExactlyOnceWith(scope, course, ...args);
    for (const other of Object.values(methods)) if (other !== method) expect(other).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });
});
describe("route forwarding never converts a dependency rejection into success", () => {
  it.each(cases)("propagates failure from $name", async ({ method, call }) => {
    const error = Object.assign(new Error("owned dependency unavailable"), { code: "CONFLICT" });
    method.mockRejectedValue(error);
    await expect(call(createCourseRouteService(sql, {}), { workspaceId: id(40), ownerUserId: id(41) }, id(30))).rejects.toBe(error);
  });
  it.each(cases)("rejects malformed course before $name dispatch", ({ call }) => {
    expect(() => call(createCourseRouteService(sql, {}), { workspaceId: id(40), ownerUserId: id(41) }, "not-a-course")).toThrow();
    for (const method of Object.values(methods)) expect(method).not.toHaveBeenCalled();
  });
});
