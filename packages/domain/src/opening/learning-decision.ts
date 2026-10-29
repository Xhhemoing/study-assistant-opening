export type LearningDecisionLayer = "plan" | "session" | "activity";
export type LearningDecisionVersions = { stateVersion: string; goalVersion: string; intentVersion: string; policyVersion: string };
export type LearningDecisionCandidate = { action: string; eligible: boolean; reasonCodes: string[]; evidenceRefs: string[] };
export type LearningDecisionInput = LearningDecisionVersions & {
  layer: LearningDecisionLayer; targetId: string; parentDecisionId?: string | null;
  candidates: LearningDecisionCandidate[]; selectedAction: string; reasonCodes: string[]; evidenceRefs: string[];
  sourceVersions: Record<string, number[]>; dataAsOf: string;
  invalidationConditions: Array<"state_changed" | "goal_changed" | "intent_changed" | "policy_changed" | "source_changed">;
};
export type LearningDecision = LearningDecisionInput & { id: string; createdAt: string };
export function learningDecisionInvalidation(decision: LearningDecisionInput, current: LearningDecisionVersions & {
  sourceVersions: Record<string, number[]>;
}): string[] {
  const checks = { state_changed: decision.stateVersion !== current.stateVersion,
    goal_changed: decision.goalVersion !== current.goalVersion, intent_changed: decision.intentVersion !== current.intentVersion,
    policy_changed: decision.policyVersion !== current.policyVersion,
    source_changed: JSON.stringify(Object.entries(decision.sourceVersions).sort()) !== JSON.stringify(Object.entries(current.sourceVersions).sort()) };
  return decision.invalidationConditions.filter(condition => checks[condition]);
}
export function validateLearningDecision(input: LearningDecisionInput): void {
  const fail = () => { throw Object.assign(new Error("Decision requires captured versions, reasons and an eligible selected candidate"), { code: "VALIDATION" }); };
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0);
  if (!input || typeof input !== "object" || !["plan", "session", "activity"].includes(input.layer)
    || [input.stateVersion, input.goalVersion, input.intentVersion, input.policyVersion, input.targetId, input.selectedAction].some(value => typeof value !== "string" || !value.length)
    || !Number.isFinite(Date.parse(input.dataAsOf)) || !strings(input.reasonCodes) || !input.reasonCodes.length || !strings(input.evidenceRefs)
    || !Array.isArray(input.candidates) || !input.candidates.every(candidate => candidate && typeof candidate.action === "string"
      && typeof candidate.eligible === "boolean" && strings(candidate.reasonCodes) && strings(candidate.evidenceRefs))
    || !input.candidates.some(candidate => candidate.action === input.selectedAction && candidate.eligible)
    || !input.sourceVersions || typeof input.sourceVersions !== "object" || Array.isArray(input.sourceVersions)
    || !Object.values(input.sourceVersions).every(versions => Array.isArray(versions) && versions.every(version => Number.isInteger(version) && version >= 0))
    || !Array.isArray(input.invalidationConditions) || !input.invalidationConditions.includes("state_changed")
    || !input.invalidationConditions.every(condition => ["state_changed", "goal_changed", "intent_changed", "policy_changed", "source_changed"].includes(condition))) fail();
  if (input.layer === "plan" && input.parentDecisionId) throw Object.assign(new Error("Plan decision cannot have a parent"), { code: "VALIDATION" });
}
