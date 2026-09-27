export function canProposePlan(input: { start: string; end: string }): boolean {
  if (!input.start || !input.end) return false;
  return Date.parse(input.end) > Date.parse(input.start);
}
