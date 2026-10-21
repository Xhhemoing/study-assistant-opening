import { expect, it, vi } from "vitest";
import { createInlineAttemptPreparation, type InlineAttemptPreparationCheckpoint } from "./inline-attempt-prepare";
import { createInlineAttemptSubmission } from "./inline-attempt-submission";
import { createInlineAttemptDrafts, inlineAttemptDraftConflict, inlineAttemptIdentityKey, type InlineAttemptDraftStorage } from "./inline-attempt-drafts";
import type { LearningAttempt } from "@aistudy/contracts";
const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const input = { activityId: id, courseId: id, blockId: id, contentVersion: 1, sourceIds: [id], prompt: "题目", skillLabel: "技能" };
const attempt: LearningAttempt = { id, workspaceId: id, sessionId: id, courseId: id, skillLabel: input.skillLabel, requirementKey: `teaching:${id}:v1`, sourceIds: [id], sourceVersions: { [id]: 1 }, problemId: null, itemVersionId: null, submittedAt: null, observationId: null, startedAt: "2026-10-21T00:00:00Z" };
function client() { return { createSession: vi.fn().mockResolvedValue({ id }), createAttempt: vi.fn().mockResolvedValue(attempt), submitAttempt: vi.fn().mockResolvedValue({ id, attemptId: id, sessionId: id, courseId: id }) }; }
it("prepares canonical identity without an answer, then seals only the actual submitted text under that same identity", async () => {
  const api = client(); let checkpoint!: InlineAttemptPreparationCheckpoint;
  const controller = createInlineAttemptPreparation(input, api, { onCheckpoint: value => { checkpoint = value; } });
  const first = controller.prepare(); expect(controller.prepare()).toBe(first);
  expect(await first).toBe(attempt); expect(api.submitAttempt).not.toHaveBeenCalled();
  expect(checkpoint).not.toHaveProperty("submitKey"); expect(checkpoint.input).not.toHaveProperty("answer");
  await createInlineAttemptSubmission({ ...input, answer: "提示后继续完成的原答案" }, api, { preparation: checkpoint }).submit();
  expect(api.createSession).toHaveBeenCalledOnce();
  expect(api.createAttempt.mock.calls[1]).toEqual(api.createAttempt.mock.calls[0]);
  expect(api.submitAttempt).toHaveBeenCalledWith(id, expect.objectContaining({ answer: "提示后继续完成的原答案", outcome: "unverified" }));
});
it("replays the saved prepare request after a lost reply and reload without trusting a browser attempt object", async () => {
  const api = client(); let checkpoint!: InlineAttemptPreparationCheckpoint;
  api.createAttempt.mockRejectedValueOnce(new Error("lost reply"));
  await expect(createInlineAttemptPreparation(input, api, { onCheckpoint: value => { checkpoint = value; } }).prepare()).rejects.toThrow("lost reply");
  expect(checkpoint.sessionId).toBe(id);
  vi.resetModules(); const { createInlineAttemptPreparation: restore } = await import("./inline-attempt-prepare");
  expect(await restore(input, api, { checkpoint: JSON.parse(JSON.stringify(checkpoint)), onCheckpoint: vi.fn() }).prepare()).toBe(attempt);
  expect(api.createSession).toHaveBeenCalledOnce(); expect(api.createAttempt.mock.calls[1]).toEqual(api.createAttempt.mock.calls[0]);
});
it.each([{ courseId: other }, { sessionId: other }, { requirementKey: `teaching:${id}:v2` }])("rejects a mismatched canonical prepare result", async patch => {
  const api = client(); api.createAttempt.mockResolvedValue({ ...attempt, ...patch });
  await expect(createInlineAttemptPreparation(input, api, { onCheckpoint: vi.fn() }).prepare()).rejects.toThrow("不一致");
});
it.each(["session", "attempt"] as const)("publishes completed identity to a remounted consumer while %s is still pending", async phase => {
  const api = client(); let original!: InlineAttemptPreparationCheckpoint, restored!: InlineAttemptPreparationCheckpoint;
  let resolve!: (value: LearningAttempt | { id: string }) => void;
  if (phase === "session") api.createSession.mockReturnValueOnce(new Promise(value => { resolve = value; }));
  else api.createAttempt.mockReturnValueOnce(new Promise(value => { resolve = value; }));
  const first = createInlineAttemptPreparation(input, api, { onCheckpoint: value => { original = value; } }).prepare();
  await Promise.resolve();
  const returned = createInlineAttemptPreparation(input, api, { checkpoint: JSON.parse(JSON.stringify(original)), onCheckpoint: value => { restored = value; } }).prepare();
  resolve(phase === "session" ? { id } : attempt); await Promise.all([first, returned]);
  expect(restored).toMatchObject({ sessionId: id, attemptId: id });
  await createInlineAttemptSubmission({ ...input, answer: "重挂后完成的首答" }, api, { preparation: restored }).submit();
  expect(api.createSession).toHaveBeenCalledOnce(); expect(api.createAttempt.mock.calls[1]).toEqual(api.createAttempt.mock.calls[0]);
});
it("publishes a session obtained during a failed shared prepare to the returning form", async () => {
  const api = client(); let original!: InlineAttemptPreparationCheckpoint, restored!: InlineAttemptPreparationCheckpoint;
  let resolve!: (value: { id: string }) => void;
  api.createSession.mockReturnValueOnce(new Promise(value => { resolve = value; })); api.createAttempt.mockRejectedValueOnce(new Error("lost attempt reply"));
  const first = createInlineAttemptPreparation(input, api, { onCheckpoint: value => { original = value; } }).prepare();
  const second = createInlineAttemptPreparation(input, api, { checkpoint: JSON.parse(JSON.stringify(original)), onCheckpoint: value => { restored = value; } }).prepare();
  resolve({ id }); await Promise.allSettled([first, second]);
  expect(restored.sessionId).toBe(id);
  await createInlineAttemptSubmission({ ...input, answer: "仍保留的首答" }, api, { preparation: restored }).submit();
  expect(api.createSession).toHaveBeenCalledOnce(); expect(api.createAttempt.mock.calls[1]).toEqual(api.createAttempt.mock.calls[0]);
});
it("persists a prepared identity while edits remain mutable and rejects cross-version or course restored identity", async () => {
  const values = new Map<string, string>();
  const storage: InlineAttemptDraftStorage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
  const drafts = createInlineAttemptDrafts(storage), key = inlineAttemptIdentityKey(id, id, 1);
  let checkpoint!: InlineAttemptPreparationCheckpoint;
  await createInlineAttemptPreparation(input, client(), { onCheckpoint: value => { checkpoint = value; } }).prepare();
  drafts.set(key, { answer: "尚可继续编辑", skillLabel: input.skillLabel, prompt: input.prompt, preparation: checkpoint });
  const restored = createInlineAttemptDrafts(storage).get(key)!; expect(restored.answer).toBe("尚可继续编辑");
  expect(inlineAttemptDraftConflict(restored, { courseId: other, prompt: input.prompt })).toBe("course_changed");
  const storageKey = [...values.keys()][0]!;
  values.set(storageKey, JSON.stringify({ ...restored, preparation: { ...checkpoint, input: { ...input, contentVersion: 2 } } }));
  expect(drafts.get(key)).toBeUndefined();
});
