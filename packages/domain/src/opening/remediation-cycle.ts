/** Server-assembled facts only; never accept this projection from a learner or model. */
export type RemediationCycleObservation = {
  id: string;
  rootId: string;
  verifiedCorrect: "yes" | "no" | "unknown";
  independentFailure: boolean;
  deliveredAssistance: boolean;
  answerAt: number;
  verifiedErrorLabels: readonly string[];
};
export type RemediationCycleActivity = {
  id: string;
  parentActivityId: string | null;
  /** Exact scope/course/requirement/skill/source-version identity. */
  identity: string;
  originObservationId: string | null;
  observations: readonly RemediationCycleObservation[];
  help: readonly { id: string; deliveredAt: number; level: "hinted" | "revealed" }[];
};
export type CompletedRemediationCycle = {
  failureRootId: string;
  evidenceRefs: readonly string[];
  repeatedVerifiedError: boolean;
  persistentDeliveredAssistance: boolean;
};
export type RemediationCycleSummary = {
  /** Recent consecutive cycles, with failure roots deduplicated; length is 0 / 1 / 2+. */
  completedCycles: readonly CompletedRemediationCycle[];
};

/** Effective heads retain their original submission order; an activity is not a round. */
export function summarizeRemediationCycles(chain: readonly RemediationCycleActivity[]): RemediationCycleSummary {
  const completed: CompletedRemediationCycle[] = [];
  const roots = new Set<string>();
  const repeatedLabels = new Map<string, readonly string[]>();
  let failure: RemediationCycleObservation | undefined;
  const interrupt = () => {
    completed.length = 0;
    roots.clear();
    repeatedLabels.clear();
    failure = undefined;
  };
  for (let index = 0; index < chain.length; index++) {
    const activity = chain[index]!, parent = chain[index - 1];
    if (parent) {
      const origin = parent.observations.find(row => row.id === activity.originObservationId);
      if (activity.parentActivityId !== parent.id || activity.identity !== parent.identity
        || !origin || origin.verifiedCorrect === "unknown") interrupt();
      // Only the explicitly selected parent result may seed a child correction.
      failure = activity.parentActivityId === parent.id && activity.identity === parent.identity
        && origin?.verifiedCorrect === "no" && origin.independentFailure ? origin : undefined;
    }
    const observations = [...activity.observations].sort((a, b) => a.answerAt - b.answerAt || a.id.localeCompare(b.id));
    const seen = new Set<string>();
    for (const followup of observations) {
      // Repository supplies one effective head per root. Never count a duplicate
      // or a regrade of that root as a new independent submission.
      if (seen.has(followup.rootId)) continue;
      seen.add(followup.rootId);
      if (followup.verifiedCorrect === "unknown" || followup.verifiedCorrect === "yes" && !followup.deliveredAssistance) {
        interrupt();
        continue;
      }
      const help = failure && followup.rootId !== failure.rootId ? activity.help.filter(row =>
        row.deliveredAt > failure!.answerAt && row.deliveredAt < followup.answerAt) : [];
      const labels = failure && followup.verifiedCorrect === "no"
        ? followup.verifiedErrorLabels.filter(label => failure!.verifiedErrorLabels.includes(label)) : [];
      // A trusted helped incorrect answer is a complete high-assistance round
      // even without error labels. Unknown is never a trusted failure/followup.
      if (failure && !roots.has(failure.rootId) && help.length
        && (followup.deliveredAssistance || labels.length)) {
        roots.add(failure.rootId);
        repeatedLabels.set(failure.rootId, labels);
        completed.push({ failureRootId: failure.rootId, repeatedVerifiedError: labels.length > 0,
          persistentDeliveredAssistance: followup.deliveredAssistance,
          evidenceRefs: [`observation:${failure.id}`, ...help.map(row => `help_exposure:${row.id}`), `observation:${followup.id}`, `activity:${activity.id}`] });
        failure = undefined;
      } else if (!followup.independentFailure) {
        interrupt();
      }
      if (followup.verifiedCorrect === "no" && followup.independentFailure && !roots.has(followup.rootId)) failure = followup;
    }
  }
  const recent = completed.slice(-2);
  if (recent.length === 2 && !repeatedLabels.get(recent[0]!.failureRootId)?.some(label => repeatedLabels.get(recent[1]!.failureRootId)?.includes(label))) {
    for (const cycle of recent) cycle.repeatedVerifiedError = false;
  }
  return { completedCycles: completed };
}

export function remediationLimitEvidence(summary: RemediationCycleSummary | undefined): string[] | null {
  const recent = summary?.completedCycles.slice(-2);
  if (!recent || recent.length < 2 || new Set(recent.map(row => row.failureRootId)).size !== 2
    || recent.some(row => !row.evidenceRefs.length)) return null;
  if (!recent.every(row => row.repeatedVerifiedError) && !recent.every(row => row.persistentDeliveredAssistance)) return null;
  return [...new Set(recent.flatMap(row => [...row.evidenceRefs]))];
}
