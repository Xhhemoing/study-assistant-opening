import { z } from "zod";

const identitySchema = z.object({ courseId: z.string().uuid(), observationId: z.string().uuid(), rootId: z.string().uuid(), grantRevision: z.number().int().nonnegative() });
const attemptSchema = identitySchema.extend({ phase: z.enum(["pending", "conflict"]) }).strict();
export type DelayedRetestIdentity = z.infer<typeof identitySchema>;
export type DelayedRetestAttempt = z.infer<typeof attemptSchema>;
const key = (identity: DelayedRetestIdentity) => `aistudy:span-delayed-attempt:v1:${identity.courseId}:${identity.observationId}:${identity.rootId}`;

/** This is a tab-local trigger receipt, never authorization or proof that a task exists. */
export function readDelayedRetestAttempt(identity: DelayedRetestIdentity): DelayedRetestAttempt | null {
  const raw = window.sessionStorage.getItem(key(identity));
  if (raw === null) return null;
  if (raw.length > 1024) throw new Error("自动复测触发记录无法读取，请先查看今日任务。");
  const attempt = attemptSchema.parse(JSON.parse(raw));
  if (attempt.courseId !== identity.courseId || attempt.observationId !== identity.observationId
    || attempt.rootId !== identity.rootId) throw new Error("自动复测触发记录不一致，请查看原任务或手动确认。");
  // A changed grant may reconsider a definite refusal, never silently change an unknown request.
  return attempt.phase === "conflict" && attempt.grantRevision !== identity.grantRevision ? null : attempt;
}
export function saveDelayedRetestAttempt(identity: DelayedRetestIdentity, phase: DelayedRetestAttempt["phase"]): void {
  window.sessionStorage.setItem(key(identity), JSON.stringify({ ...identity, phase }));
}
export function clearDelayedRetestAttempt(identity: DelayedRetestIdentity): void {
  window.sessionStorage.removeItem(key(identity));
}
