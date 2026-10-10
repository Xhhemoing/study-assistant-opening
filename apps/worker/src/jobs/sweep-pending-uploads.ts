/**
 * Pipeline G4: scheduled pending-upload TTL sweep.
 *
 * Calls Data's `sweepExpiredPendingUploadsAll` (or a injected `sweepAll`).
 * Returned `{ id, workspaceId }[]` is the optional notify hook — this module
 * does **not** send Slack, email, or in-app notices.
 */

export type SweptPendingUploadRef = { id: string; workspaceId: string };

export type SweepPendingUploadsOptions = {
  now?: Date;
  /** Max rows per sweep; Data default is PENDING_UPLOAD_TTL_SWEEP_LIMIT (100). */
  limit?: number;
};

export type SweepPendingUploadsDeps = {
  sweepAll: (options?: SweepPendingUploadsOptions) => Promise<SweptPendingUploadRef[]>;
};

export type SweepPendingUploadsResult = {
  swept: SweptPendingUploadRef[];
  count: number;
};

/** Worker interval for the global pending-upload TTL sweep (1 minute). */
export const PENDING_UPLOAD_SWEEP_INTERVAL_MS = 60_000;

/**
 * Pure-ish job runner: one call → one `sweepAll` invocation → structured result.
 * No logging / notify delivery (caller may use `count` / `swept` later).
 */
export function createSweepPendingUploadsJob(deps: SweepPendingUploadsDeps) {
  return async function runSweepPendingUploads(
    options?: SweepPendingUploadsOptions,
  ): Promise<SweepPendingUploadsResult> {
    const swept = await deps.sweepAll(options);
    return { swept, count: swept.length };
  };
}
