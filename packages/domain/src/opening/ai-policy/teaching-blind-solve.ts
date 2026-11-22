import { isDeepStrictEqual } from "node:util";
import { teachingBlindSolveReceiptSchema, type TeachingBlindSolveReceipt, type TeachingBlindSolveIdentity } from "@aistudy/contracts";

/** Eligibility metadata only. This is NOT a learner verdict or an independence upgrade. */
export function teachingBlindSolveMatchesCurrent(receipt: TeachingBlindSolveReceipt | null | undefined, identity: TeachingBlindSolveIdentity): boolean {
  return teachingBlindSolveReceiptSchema.safeParse(receipt).success && receipt?.decision === "match"
    && !!receipt.costLedgerRef && !!receipt.modelSnapshot && !!receipt.family
    && isDeepStrictEqual(receipt.identity, identity);
}
