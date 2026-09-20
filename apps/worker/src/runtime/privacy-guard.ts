export class PrivacyEpochError extends Error {
  readonly code = "PRIVACY_EPOCH_MISMATCH" as const;
  constructor(message: string) {
    super(message);
    this.name = "PrivacyEpochError";
  }
}

/** Epoch mismatch means personal context was deleted/revoked after the job was built. */
export function assertCurrentEpoch(jobEpoch: number, currentEpoch: number): void {
  if (jobEpoch !== currentEpoch) {
    throw new PrivacyEpochError(
      `privacy epoch mismatch: job=${jobEpoch} current=${currentEpoch}`,
    );
  }
}
