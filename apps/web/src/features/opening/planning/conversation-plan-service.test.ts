import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import type { Scope } from "@aistudy/contracts";
import type { LocalPlanAdditional, LocalPlanOptions } from "@aistudy/database";
const { read, course, preference, replay } = vi.hoisted(() => ({ read: vi.fn(), course: vi.fn(), preference: vi.fn(), replay: vi.fn() }));
vi.mock("@aistudy/database", async original => ({ ...await original<typeof import("@aistudy/database")>(),
  readOpeningConversationPlanCandidate: read, assertOpeningConversationPlanCourse: course,
  admitOpeningConversationPlanReplay: replay, createOpeningPlanningSettingsRepository: () => ({ get: preference }),
}));
import { createConversationPlanService } from "./conversation-plan-service";
const id = "11111111-1111-4111-8111-111111111111", courseId = "22222222-2222-4222-8222-222222222222";
const scope: Scope = { workspaceId: id, ownerUserId: courseId };
const input = { candidateId: id, expectedVersion: 0, date: "2026-10-16", expectedAcceptedVersion: 2, clientKey: "proposal-key-01" };
const candidate = { id, sourceTurnId: courseId, sourceIds: [], title: "对话中的练习", minutes: 20, dueText: "下周" };
const tx = vi.fn(async (parts: TemplateStringsArray) => parts.join("").includes("SELECT id, title FROM courses")
  ? [{ id: courseId, title: "我的课程" }] : [{ accepted_version: 2 }]) as unknown as TransactionSql;
const sql = { begin: async (fn: (tx: TransactionSql) => Promise<unknown>) => fn(tx) } as unknown as Sql;
beforeEach(() => {
  read.mockReset().mockResolvedValue(candidate); course.mockReset().mockResolvedValue(undefined); replay.mockReset();
  preference.mockReset().mockResolvedValue({ settings: { timeZone: "America/Los_Angeles" }, invalidStoredSettings: false });
});
function service() {
  let additional: LocalPlanAdditional | undefined, options: LocalPlanOptions | undefined;
  const propose = vi.fn(async (_sql: Sql, _scope: Scope, _input: unknown, opts: LocalPlanOptions = {}) => {
    options = opts; additional = await opts.additional!(tx);
    return { kind: "no_change" as const };
  });
  return { service: createConversationPlanService(sql, { now: () => new Date("2026-10-16T16:00:00.000Z"), propose }), propose,
    additional: () => additional!, options: () => options! };
}
describe("saved conversation to plan service", () => {
  it("requests an explicit course choice without guessing from a title", async () => {
    const s = service(), result = await s.service.propose(scope, input);
    expect(result).toMatchObject({ kind: "clarification", date: input.date, acceptedVersion: 2, missing: ["course"], courses: [{ id: courseId, name: "我的课程" }] });
    expect(course).not.toHaveBeenCalled();
  });
  it("asks for missing duration and accepts an explicit no-course choice", async () => {
    read.mockResolvedValue({ ...candidate, minutes: null });
    const s = service();
    expect(await s.service.propose(scope, { ...input, courseId: null })).toMatchObject({ kind: "clarification", missing: ["minutes"] });
    await s.service.propose(scope, { ...input, courseId: null, minutes: 15 });
    expect(s.additional().tasks[0]).toMatchObject({ title: candidate.title, minutes: 15, origin: "agent", dueAt: null });
    expect(s.additional().snapshot).toMatchObject({ conversationPlan: { candidateId: id, sourceTurnId: courseId, dueText: "下周", courseId: null } });
  });
  it("preserves the full accepted plan and schedules only the new server-owned candidate", async () => {
    const s = service(); await s.service.propose(scope, { ...input, courseId });
    expect(s.options()).toMatchObject({ preserveAll: true, taskIds: [] });
    expect(s.additional().suggestedTasks[0]).toMatchObject({ key: `conversation:${id}`, courseId, title: candidate.title });
    expect(course).toHaveBeenCalledWith(tx, scope, courseId);
    await s.options().admitReplay!(tx); expect(replay).toHaveBeenCalledWith(tx, scope, id);
  });
  it("rejects changes to a known duration and refuses an oversized candidate", async () => {
    const s = service();
    await expect(s.service.propose(scope, { ...input, courseId: null, minutes: 25 })).rejects.toMatchObject({ code: "VALIDATION" });
    read.mockResolvedValue({ ...candidate, minutes: 300 });
    await expect(s.service.propose(scope, { ...input, courseId: null, minutes: 20 })).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it("rejects client-authored task text and stale candidate versions before proposing", async () => {
    const s = service();
    await expect(s.service.propose(scope, { ...input, title: "forged" })).rejects.toThrow();
    await expect(s.service.propose(scope, { ...input, expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(s.propose).not.toHaveBeenCalled();
  });
});
