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

/** The chain ends at the selected origin, not at the newest activity in the course. */
export function summarizeRemediationCycles(chain: readonly RemediationCycleActivity[]): RemediationCycleSummary {
  const completed: CompletedRemediationCycle[] = [];
  const roots = new Set<string>();
  const repeatedLabels = new Map<string, readonly string[]>();
  for (let index = 1; index < chain.length; index++) {
    const parent = chain[index - 1]!, activity = chain[index]!;
    if (activity.parentActivityId !== parent.id || activity.identity !== parent.identity) {
      completed.length = 0;
      roots.clear();
      continue;
    }
    const failure = parent.observations.find(row => row.id === activity.originObservationId
      && row.verifiedCorrect === "no" && row.independentFailure);
    const followup = failure ? activity.observations.find(row => row.rootId !== failure.rootId
      && row.answerAt > failure.answerAt && activity.help.some(help => help.deliveredAt > failure.answerAt && help.deliveredAt < row.answerAt)
      && (row.verifiedCorrect === "yes" && row.deliveredAssistance || row.verifiedCorrect === "no"
        && row.verifiedErrorLabels.some(label => failure.verifiedErrorLabels.includes(label)))) : undefined;
    const latest = activity.observations.at(-1);
    if (!latest || latest.verifiedCorrect === "unknown" || latest.verifiedCorrect === "yes" && !latest.deliveredAssistance) {
      completed.length = 0;
      roots.clear();
      continue;
    }
    // Only help delivered in this correction activity, after the failure and
    // before a different trusted answer, completes a cycle. Regrading is not a round.
    const help = failure && followup ? activity.help.filter(row => row.deliveredAt > failure.answerAt && row.deliveredAt < followup.answerAt) : [];
    const repeatedVerifiedError = !!failure && !!followup && followup.verifiedCorrect === "no"
      && followup.verifiedErrorLabels.some(label => failure.verifiedErrorLabels.includes(label));
    if (failure && followup && !roots.has(failure.rootId) && followup.rootId !== failure.rootId && help.length
      && (followup.verifiedCorrect === "yes" || repeatedVerifiedError)) {
      roots.add(failure.rootId);
      repeatedLabels.set(failure.rootId, followup.verifiedErrorLabels.filter(label => failure.verifiedErrorLabels.includes(label)));
      completed.push({ failureRootId: failure.rootId, repeatedVerifiedError,
        persistentDeliveredAssistance: followup.deliveredAssistance,
        evidenceRefs: [`observation:${failure.id}`, ...help.map(row => `help_exposure:${row.id}`), `observation:${followup.id}`, `activity:${activity.id}`] });
    } else {
      // Missing/unsupported correction interrupts consecutive rounds. A later
      // independent failure may start a new chain, not bridge the gap.
      completed.length = 0;
      roots.clear();
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
