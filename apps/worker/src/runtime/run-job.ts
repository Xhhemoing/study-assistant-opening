import type { OpeningJobRecord } from "@aistudy/database";
import { isBudgetReplayError, ledgerActionForProviderError, OpeningProviderError } from "@aistudy/ai";
import { withJobHeartbeat } from "./lifecycle";

export type JobHandler = (job: OpeningJobRecord, payload: unknown) => Promise<unknown>;
export type JobRepository = {
  claim(id: string): Promise<OpeningJobRecord | null>;
  /** M02 workspace epoch; implemented by createOpeningJobRepository. Optional only for unit doubles. */
  workspacePrivacyEpoch?(workspaceId: string): Promise<number>;
  heartbeat?(id: string, claimToken: string): Promise<boolean>;
  finish(id: string, state: "succeeded" | "failed" | "outcome_unknown", value: unknown, claimToken?: string): Promise<boolean>;
};

const UNKNOWN_OUTCOME_CODES = new Set(["PROVIDER_TIMEOUT", "PROVIDER_NETWORK"]);

export function canClaimJob(status: string): boolean {
  return status === "queued";
}

export function isUnknownOutcome(error: unknown, kind?: string): boolean {
  if (kind === "grade-observation" && (error as { code?: string } | null)?.code === "GRADING_UNKNOWN_COST") return true;
  if (kind === "recognize-photo-question" || kind === "grade-observation") {
    if (isBudgetReplayError(error)) return error.disposition.kind === "unknown" || error.disposition.kind === "in_flight";
    if (error instanceof OpeningProviderError) return ledgerActionForProviderError(error.code, { requestSent: error.requestSent }) === "markUnknown";
  }
  return error instanceof OpeningProviderError && UNKNOWN_OUTCOME_CODES.has(error.code);
}

/** A manual parse retry may reuse saved chunks, but must not invite unknown model calls. */
function canRetryParse(error: unknown): boolean {
  if (isBudgetReplayError(error)) return error.disposition.kind === "released";
  if (error instanceof OpeningProviderError) {
    return error.retryable && ledgerActionForProviderError(error.code) === "release";
  }
  if (error instanceof TypeError || error instanceof RangeError) return false;
  const details = error as { code?: unknown; retryable?: unknown } | null;
  if (typeof details?.code === "string" && [
    "MEDIA_VALIDATION", "CONFIGURATION", "UNSUPPORTED_SOURCE", "UNSUPPORTED_MIME",
    "BOUNDS_EXCEEDED", "USAGE", "PRIVACY_EPOCH_MISMATCH", "BUDGET_CONFLICT",
    "CONFLICT", "NOT_FOUND", "VALIDATION",
  ].includes(details.code)) return false;
  if (typeof details?.retryable === "boolean") return details.retryable;
  // Ordinary download, filesystem or interrupted conversion errors can be retried
  // explicitly. The adapter/ledger still owns the right to send each model call.
  return true;
}

/**
 * Dispatch + writeback: workspace privacy epoch must still match the job snapshot.
 * Only a real mismatch is reported as a privacy change. Lookup failures propagate:
 * before dispatch the interruption is recovered without automatic re-execution; after the handler it is recorded
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
  if (!job || job.state !== "running") return false;
  return withJobHeartbeat(
    () => repository.heartbeat && job.claimToken ? repository.heartbeat(job.id, job.claimToken) : Promise.resolve(),
    async () => {
      if (!(await workspaceEpochIsCurrent(repository, job))) {
        await repository.finish(job.id, "failed", { error: "workspace privacy epoch changed; job discarded" }, job.claimToken);
        return false;
      }
      try {
        const result = await handler(job, job.payload);
        if (!(await workspaceEpochIsCurrent(repository, job))) {
          await repository.finish(job.id, "failed", { error: "workspace privacy epoch changed before writeback" }, job.claimToken);
          return false;
        }
        return repository.finish(job.id, "succeeded", result, job.claimToken);
      } catch (error) {
        const state = isUnknownOutcome(error, job.kind) ? "outcome_unknown" : "failed";
        return repository.finish(job.id, state, {
          error: error instanceof Error ? error.message : "job failed",
          ...(job.kind === "parse" || job.kind === "parse-media" ? { retryable: state !== "outcome_unknown" && canRetryParse(error) } : {}),
        }, job.claimToken);
      }
    },
  );
}
