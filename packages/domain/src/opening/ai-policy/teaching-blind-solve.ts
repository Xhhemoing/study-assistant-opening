import { teachingBlindSolveReceiptSchema, type TeachingBlindSolveReceipt, type TeachingBlindSolveIdentity } from "@aistudy/contracts";

// Compare the receipt's scalar fields and nested records without normalizing them.
// In particular, an omitted field differs from a field explicitly set to undefined.
function sameIdentityValue(left: unknown, right: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(left);
  if (prototype !== Object.getPrototypeOf(right) || (prototype !== Object.prototype && prototype !== null)) return false;
  if (seen.has(left)) return seen.get(left) === right;
  const leftKeys = Reflect.ownKeys(left).filter(key => Object.prototype.propertyIsEnumerable.call(left, key));
  const rightKeys = Reflect.ownKeys(right).filter(key => Object.prototype.propertyIsEnumerable.call(right, key));
  seen.set(left, right);
  const equal = leftKeys.length === rightKeys.length && leftKeys.every(key =>
    rightKeys.includes(key) && sameIdentityValue(Reflect.get(left, key), Reflect.get(right, key), seen));
  seen.delete(left);
  return equal;
}

/** Eligibility metadata only. This is NOT a learner verdict or an independence upgrade. */
export function teachingBlindSolveMatchesCurrent(receipt: TeachingBlindSolveReceipt | null | undefined, identity: TeachingBlindSolveIdentity): boolean {
  return teachingBlindSolveReceiptSchema.safeParse(receipt).success && receipt?.decision === "match"
    && !!receipt.costLedgerRef && !!receipt.modelSnapshot && !!receipt.family
    && sameIdentityValue(receipt.identity, identity);
}
