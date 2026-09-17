import type { OpeningJobRecord } from "@aistudy/database";
import { OpeningProviderError } from "@aistudy/ai";

export type JobHandler = (job: OpeningJobRecord, payload: unknown) => Promise<unknown>;
export type JobRepository = {
  claim(id: string): Promise<OpeningJobRecord | null>;
  sourcePrivacyEpoch(sourceId: string, workspaceId: string): Promise<number | null>;
  finish(id: string, state: "succeeded" | "failed" | "outcome_unknown", value: unknown): Promise<boolean>;
};

const UNKNOWN_OUTCOME_CODES = new Set(["PROVIDER_TIMEOUT", "PROVIDER_NETWORK"]);

export function canClaimJob(status: string): boolean {
  return status === "queued" || status === "running";
}

export function isUnknownOutcome(error: unknown): boolean {
  return error instanceof OpeningProviderError && UNKNOWN_OUTCOME_CODES.has(error.code);
}

async function validateParseSource(repository: JobRepository, job: OpeningJobRecord): Promise<boolean> {
  if (job.kind !== "parse") return true;
  const payload = job.payload as { sourceId?: unknown };
  if (typeof payload.sourceId !== "string") return false;
  const currentEpoch = await repository.sourcePrivacyEpoch(payload.sourceId, job.workspaceId);
  return currentEpoch !== null && currentEpoch === job.privacyEpoch;
}

export async function runJob(
  repository: JobRepository,
  jobId: string,
  handler: JobHandler,
): Promise<boolean> {
  const job = await repository.claim(jobId);
  if (!job || !canClaimJob(job.state)) return false;
  if (!(await validateParseSource(repository, job))) {
    await repository.finish(job.id, "failed", { error: "source privacy epoch changed; parse result discarded" });
    return false;
  }
  try {
    const result = await handler(job, job.payload);
    return repository.finish(job.id, "succeeded", result);
  } catch (error) {
    const state = isUnknownOutcome(error) ? "outcome_unknown" : "failed";
    return repository.finish(job.id, state, { error: error instanceof Error ? error.message : "job failed" });
  }
}
