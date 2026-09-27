export function canAcceptPlan(input: { pending: boolean; stale: boolean }): boolean {
  return !input.pending && !input.stale;
}
