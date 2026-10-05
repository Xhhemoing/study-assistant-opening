import type { OpeningJobRecord } from "@aistudy/database";
import { OpeningProviderError } from "@aistudy/ai";

export type JobHandler = (job: OpeningJobRecord, payload: unknown) => Promise<unknown>;
export type JobRepository = {
  claim(id: string): Promise<OpeningJobRecord | null>;
  /** M02 workspace epoch; implemented by createOpeningJobRepository. Optional only for unit doubles. */
  workspacePrivacyEpoch?(workspaceId: string): Promise<number>;
  finish(id: string, state: "succeeded" | "failed" | "outcome_unknown", value: unknown): Promise<boolean>;
};

const UNKNOWN_OUTCOME_CODES = new Set(["PROVIDER_TIMEOUT", "PROVIDER_NETWORK"]);

export function canClaimJob(status: string): boolean {
  return status === "queued" || status === "running";
}

export function isUnknownOutcome(error: unknown): boolean {
  return error instanceof OpeningProviderError && UNKNOWN_OUTCOME_CODES.has(error.code);
}

/**
 * Dispatch + writeback: workspace privacy epoch must still match the job snapshot.
 * Only a real mismatch is reported as a privacy change. Lookup failures propagate:
 * before dispatch the claimed job stays retryable, after the handler it is recorded
 * as failed with the actual error instead of masquerading as an epoch change.
 */
async function workspaceEpochIsCurrent(repository: JobRepository, job: OpeningJobRecord): Promise<boolean> {
  if (!repository.workspacePrivacyEpoch) return true;
  const current = await repository.workspacePrivacyEpoch(job.workspaceId);
  return current === job.privacyEpoch;
}

export async function runJob(
  repository: JobRepository,
  jobId: string,
  handler: JobHandler,
): Promise<boolean> {
  const job = await repository.claim(jobId);
  if (!job || !canClaimJob(job.state)) return false;
  if (!(await workspaceEpochIsCurrent(repository, job))) {
    await repository.finish(job.id, "failed", { error: "workspace privacy epoch changed; job discarded" });
    return false;
  }
  try {
    const result = await handler(job, job.payload);
    if (!(await workspaceEpochIsCurrent(repository, job))) {
      await repository.finish(job.id, "failed", { error: "workspace privacy epoch changed before writeback" });
      return false;
    }
    return repository.finish(job.id, "succeeded", result);
  } catch (error) {
    const state = isUnknownOutcome(error) ? "outcome_unknown" : "failed";
    return repository.finish(job.id, state, { error: error instanceof Error ? error.message : "job failed" });
  }
}
