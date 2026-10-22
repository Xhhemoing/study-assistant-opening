import { z } from "zod";
import { acceptPlanInputSchema, planDraftSchema, type AcceptPlanInput, type PlanDraft } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { selectableSuggestedKeys } from "../planning/daily-draft-selection";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
const schema = z.object({ version: z.literal(1), courseId: z.string().uuid(), date: dateSchema,
  draft: planDraftSchema.refine(draft => draft.status === "draft" && draft.blocks.every(block => Date.parse(block.end) > Date.parse(block.start))),
  acceptInput: acceptPlanInputSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.date !== value.draft.date) context.addIssue({ code: "custom", message: "Candidate date changed" });
  const input = value.acceptInput;
  if (input && (input.draftId !== value.draft.id || input.expectedBaseVersion !== value.draft.baseVersion
    || JSON.stringify(input.acceptSuggestedKeys) !== JSON.stringify(selectableSuggestedKeys(value.draft).sort()))) {
    context.addIssue({ code: "custom", message: "Application identity changed" });
  }
});
export type SprintCheckpoint = z.infer<typeof schema>;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export type SprintRecovery = { kind: "none" } | { kind: "saved"; checkpoint: SprintCheckpoint } | { kind: "invalid" | "obsolete"; message: string };
const key = (courseId: string) => `study:sprint:v1:${courseId}`;

/** Saved browser data is only a preview and request identity, never an application receipt. */
export function readSprintCheckpoint(courseId: string, date: string, storage?: Storage): SprintRecovery {
  try {
    const raw = (storage ?? window.sessionStorage).getItem(key(courseId));
    if (!raw) return { kind: "none" };
    const parsed = schema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { kind: "invalid", message: "保存的冲刺恢复记录不完整，已停止应用。请先清除恢复记录，再重新读取候选。" };
    if (parsed.data.courseId !== courseId || parsed.data.date !== date) return { kind: "obsolete", message: "上次候选属于另一日期或课程，不能应用到当前计划。请清除恢复记录后重新安排。" };
    return { kind: "saved", checkpoint: parsed.data };
  } catch { return { kind: "invalid", message: "暂时无法读取冲刺恢复记录，已停止应用。请检查浏览器存储后重试。" }; }
}

/** Persist before sending: an unavailable store must not create an unrecoverable write. */
export function saveSprintCheckpoint(checkpoint: SprintCheckpoint, storage?: Storage): void {
  const value = schema.parse(checkpoint);
  try { (storage ?? window.sessionStorage).setItem(key(value.courseId), JSON.stringify(value)); }
  catch { throw new Error("无法保存冲刺恢复记录，尚未发送应用请求。请允许浏览器存储后重试。"); }
}
export function clearSprintCheckpoint(courseId: string, storage?: Storage): void {
  try { (storage ?? window.sessionStorage).removeItem(key(courseId)); }
  catch { throw new Error("无法清除冲刺恢复记录，请检查浏览器存储后重试。"); }
}
export function sprintAcceptance(draft: PlanDraft): AcceptPlanInput {
  return { draftId: draft.id, expectedBaseVersion: draft.baseVersion, clientKey: `sprint-accept:${crypto.randomUUID()}`, acceptSuggestedKeys: selectableSuggestedKeys(draft).sort() };
}

const requests = new Map<string, Promise<PlanDraft>>();
/** Re-entering in this document can join the original write; a reload replays the same key. */
export async function resumeSprintAcceptance(courseId: string, date: string, input: AcceptPlanInput, api: Pick<OpeningApi, "acceptPlan">): Promise<PlanDraft> {
  const identity = JSON.stringify([courseId, date, input]);
  const existing = requests.get(identity);
  if (existing) return existing;
  const request = api.acceptPlan(input);
  requests.set(identity, request);
  try { return await request; }
  finally { if (requests.get(identity) === request) requests.delete(identity); }
}
