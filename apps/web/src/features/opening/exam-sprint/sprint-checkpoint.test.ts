import { describe, expect, it, vi } from "vitest";
import type { AcceptPlanInput, PlanDraft } from "@aistudy/contracts";
import { clearSprintCheckpoint, readSprintCheckpoint, resumeSprintAcceptance, saveSprintCheckpoint, sprintAcceptance, type SprintCheckpoint } from "./sprint-checkpoint";

const courseId = "11111111-1111-4111-8111-111111111111", draftId = "22222222-2222-4222-8222-222222222222", taskId = "33333333-3333-4333-8333-333333333333";
const date = "2026-10-22";
const draft: PlanDraft = { id: draftId, date, status: "draft", version: 1, baseVersion: 1,
  blocks: [{ taskId, start: `${date}T08:00:00Z`, end: `${date}T08:20:00Z`, reason: "继续" }], unscheduledTaskIds: [] };
function disk() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
const checkpoint = (acceptInput: AcceptPlanInput | null = null): SprintCheckpoint => ({ version: 1, courseId, date, draft, acceptInput });
const key = `study:sprint:v1:${courseId}`;

describe("sprint recovery identities", () => {
  it("round-trips only the candidate and exact acceptance input, never an applied flag", () => {
    const storage = disk(), saved = checkpoint(sprintAcceptance(draft));
    saveSprintCheckpoint(saved, storage);
    expect(readSprintCheckpoint(courseId, date, storage)).toEqual({ kind: "saved", checkpoint: saved });
    expect(Object.keys(JSON.parse(storage.getItem(key)!)).sort()).toEqual(["acceptInput", "courseId", "date", "draft", "version"]);
    clearSprintCheckpoint(courseId, storage);
    expect(readSprintCheckpoint(courseId, date, storage)).toEqual({ kind: "none" });
  });
  it.each([
    { ...checkpoint(), date: "2026-10-21", draft: { ...draft, date: "2026-10-21" } },
    { ...checkpoint(), courseId: "44444444-4444-4444-8444-444444444444" },
  ])("does not attach another day or course to today's plan", saved => {
    const storage = disk(); storage.setItem(key, JSON.stringify(saved));
    expect(readSprintCheckpoint(courseId, date, storage).kind).toBe("obsolete");
    expect(storage.getItem(key)).not.toBeNull();
  });
  it.each([
    { ...checkpoint(), applied: true },
    { ...checkpoint(), draft: { ...draft, status: "accepted" } },
    { ...checkpoint(), date: "2026-02-30", draft: { ...draft, date: "2026-02-30" } },
    { ...checkpoint(), date: "2026-10-21" },
    { ...checkpoint(), acceptInput: { ...sprintAcceptance(draft), draftId: taskId } },
    { ...checkpoint(), acceptInput: { ...sprintAcceptance(draft), expectedBaseVersion: 2 } },
    { ...checkpoint(), acceptInput: { ...sprintAcceptance(draft), acceptSuggestedKeys: ["injected-suggestion"] } },
    { ...checkpoint(), draft: { ...draft, blocks: [{ ...draft.blocks[0]!, end: `${date}T07:00:00Z` }] } },
  ])("rejects malformed or inconsistent persisted input without treating it as a receipt", saved => {
    const storage = disk(); storage.setItem(key, JSON.stringify(saved));
    expect(readSprintCheckpoint(courseId, date, storage).kind).toBe("invalid");
  });
  it("rejects broken JSON and reports unavailable storage before sending an application", () => {
    const storage = disk(); storage.setItem(key, "{broken");
    expect(readSprintCheckpoint(courseId, date, storage).kind).toBe("invalid");
    const denied = { ...storage, getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readSprintCheckpoint(courseId, date, denied).kind).toBe("invalid");
    expect(() => saveSprintCheckpoint(checkpoint(sprintAcceptance(draft)), denied)).toThrow("尚未发送应用请求");
  });
  it("joins a returning view's original in-flight request and preserves its key after a lost response", async () => {
    const input = sprintAcceptance(draft);
    let reject!: (reason: Error) => void;
    const api = { acceptPlan: vi.fn<(_: AcceptPlanInput) => Promise<PlanDraft>>().mockReturnValueOnce(new Promise((_, fail) => { reject = fail; })).mockResolvedValue({ ...draft, status: "accepted", version: 2 }) };
    const first = resumeSprintAcceptance(courseId, date, input, api), second = resumeSprintAcceptance(courseId, date, input, api);
    expect(api.acceptPlan).toHaveBeenCalledExactlyOnceWith(input);
    reject(new Error("response lost"));
    const failures = await Promise.allSettled([first, second]);
    expect(failures.every(result => result.status === "rejected")).toBe(true);
    await resumeSprintAcceptance(courseId, date, input, api);
    expect(api.acceptPlan.mock.calls[1]![0]).toEqual(api.acceptPlan.mock.calls[0]![0]);
  });
});
