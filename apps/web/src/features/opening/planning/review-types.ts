import { retestCandidateSchema, type AssistantCandidateRecord, type CandidateRef, type MemoryItem, type SourceRecord, type TaskCreateInput, type TaskCreateResult } from "@aistudy/contracts";
import { z } from "zod";

export const retestReviewSchema = retestCandidateSchema.extend({ kind: z.literal("task"), accepted: z.literal(false) });
export type RetestReview = z.infer<typeof retestReviewSchema>;
export type ReviewItem = {
  ref: CandidateRef;
  title: string;
  sourceNames: string[];
  version: number;
  proposal: AssistantCandidateRecord["candidate"] | (Omit<RetestReview, "kind"> & { kind: "retest" });
};
export type ReviewDraft = { title: string; minutes: string; priority: string; dueAt: string; dueText: string; expiresAt: string };
export type ReviewAction = "accept" | "discard";
export type ReviewCommand =
  | { kind: "task"; input: TaskCreateInput }
  | { kind: "memory"; input: { id: string; expectedVersion: number; clientKey: string; action: "confirm" | "reject"; expiresAt: string | null } }
  | { kind: "retest"; id: string; clientKey: string }
  | { kind: "discard"; ref: CandidateRef; clientKey: string };
export type ReviewOutcome =
  | { kind: "task"; task: TaskCreateResult; label: string }
  | { kind: "memory"; memory: MemoryItem; label: string }
  | { kind: "retest"; taskId: string; label: string }
  | { kind: "discarded"; label: string };

export function reviewItems(assistant: AssistantCandidateRecord[], retests: RetestReview[], sources: SourceRecord[]): ReviewItem[] {
  const names = new Map(sources.map((source) => [source.id, source.name]));
  const sourceNames = (ids: string[]) => ids.map((id) => names.get(id) ?? "关联材料");
  return [
    ...assistant.filter((row) => row.status === "pending").map((row): ReviewItem => ({
      ref: { origin: "assistant", kind: row.candidate.kind, id: row.id },
      title: row.candidate.kind === "task" ? row.candidate.title : "助理记忆建议",
      sourceNames: sourceNames(row.sourceIds), version: row.version, proposal: row.candidate,
    })),
    ...retests.map((row): ReviewItem => ({ ref: { origin: "retest", kind: "retest", id: row.id },
      title: row.skillLabel, sourceNames: sourceNames(row.sourceIds), version: 0,
      proposal: { ...row, kind: "retest" } })),
  ];
}
export const reviewItemKey = (item: ReviewItem) => `${item.ref.origin}:${item.ref.kind}:${item.ref.id}`;
