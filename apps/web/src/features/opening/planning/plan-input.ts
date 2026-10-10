export function canProposePlan(input: { start: string; end: string }): boolean {
  if (!input.start || !input.end) return false;
  return Date.parse(input.end) > Date.parse(input.start);
}

export type PlanProposalIntent = { date: string; inputKey: string; clientKey: string };

/** Retry one intent with one key; changed input or a new version is a new intent. */
export function planProposalIntent(
  previous: PlanProposalIntent | null,
  input: { date: string; free: readonly { start: string; end: string; kind: string }[]; baseVersion: number },
  mintKey: () => string,
): PlanProposalIntent {
  const inputKey = JSON.stringify(input);
  return previous?.inputKey === inputKey ? previous : { date: input.date, inputKey, clientKey: mintKey() };
}
