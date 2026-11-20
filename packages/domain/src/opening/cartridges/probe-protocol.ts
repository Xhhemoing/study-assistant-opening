/**
 * Distinguishable competing-misconception probe protocol.
 *
 * Pre-check gate: for the target correct model M* and competing misconception
 * hypotheses H_1..H_n, a probe input x is admissible only when every model yields
 * a strictly distinct observable: H_i(x) != H_j(x) for all i != j and
 * H_i(x) != M*(x) for all i. Otherwise a learner response cannot attribute a
 * misconception (or correctness) and must not count as formal evidence.
 */

export interface ObservableModel<TInput, TObservable> {
  id: string;
  label: string;
  predict(input: TInput): TObservable;
}

export interface CorrectModel<TInput, TObservable> extends ObservableModel<TInput, TObservable> {
  role: "correct";
}

export interface MisconceptionHypothesis<TInput, TObservable> extends ObservableModel<TInput, TObservable> {
  role: "misconception";
  description: string;
}

export interface DistinguishableProbeSpec<TInput, TObservable> {
  probeId: string;
  requirementKey: string;
  prompt: string;
  input: TInput;
  correctModel: CorrectModel<TInput, TObservable>;
  hypotheses: readonly MisconceptionHypothesis<TInput, TObservable>[];
  /** Canonical observable encoding; equal keys are indistinguishable to the evaluator. */
  observableKey(observable: TObservable): string;
  /** Parses a learner response into an observable; null means the response is not well-formed. */
  parseResponse(response: unknown): TObservable | null;
}

export type ProbeDistinguishabilityIssue =
  | "probe_identity_incomplete"
  | "no_competing_hypotheses"
  | "duplicate_model_id"
  | "prediction_failed"
  | "nondeterministic_prediction"
  | "ambiguous_hypothesis_pair"
  | "degenerate_against_correct_model";

export interface ProbeModelPrediction {
  modelId: string;
  role: "correct" | "misconception";
  observableKey: string | null;
}

export interface ProbeDistinguishabilityReport {
  probeId: string;
  distinguishable: boolean;
  predictions: ProbeModelPrediction[];
  /** Hypothesis pairs (ids sorted) that predict the same observable. */
  ambiguousPairs: Array<{ a: string; b: string; observableKey: string }>;
  /** Hypotheses whose prediction equals the correct model's prediction. */
  degenerateAgainstCorrectModel: Array<{ hypothesisId: string; observableKey: string }>;
  issues: ProbeDistinguishabilityIssue[];
}

function predictKey<TInput, TObservable>(
  spec: DistinguishableProbeSpec<TInput, TObservable>,
  model: ObservableModel<TInput, TObservable>,
  issues: Set<ProbeDistinguishabilityIssue>,
): string | null {
  try {
    const first = spec.observableKey(model.predict(spec.input));
    const second = spec.observableKey(model.predict(spec.input));
    if (first !== second) {
      issues.add("nondeterministic_prediction");
      return null;
    }
    return first;
  } catch {
    issues.add("prediction_failed");
    return null;
  }
}

/** Deterministic H_A != H_B and H_i != M* pre-check for a single probe input. */
export function verifyProbeDistinguishability<TInput, TObservable>(
  spec: DistinguishableProbeSpec<TInput, TObservable>,
): ProbeDistinguishabilityReport {
  const issues = new Set<ProbeDistinguishabilityIssue>();
  if (!spec.probeId || !spec.requirementKey || !spec.correctModel?.id) issues.add("probe_identity_incomplete");
  const hypotheses = spec.hypotheses ?? [];
  if (hypotheses.length === 0) issues.add("no_competing_hypotheses");
  const ids = [spec.correctModel?.id, ...hypotheses.map(row => row.id)];
  if (new Set(ids).size !== ids.length || ids.some(id => !id)) issues.add("duplicate_model_id");

  const correctKey = spec.correctModel ? predictKey(spec, spec.correctModel, issues) : null;
  const predictions: ProbeModelPrediction[] = [
    { modelId: spec.correctModel?.id ?? "", role: "correct", observableKey: correctKey },
    ...hypotheses.map(hypothesis => ({
      modelId: hypothesis.id,
      role: "misconception" as const,
      observableKey: predictKey(spec, hypothesis, issues),
    })),
  ];

  const ambiguousPairs: ProbeDistinguishabilityReport["ambiguousPairs"] = [];
  const degenerateAgainstCorrectModel: ProbeDistinguishabilityReport["degenerateAgainstCorrectModel"] = [];
  const misconceptions = predictions.slice(1);
  for (let i = 0; i < misconceptions.length; i += 1) {
    const left = misconceptions[i]!;
    if (left.observableKey === null) continue;
    if (correctKey !== null && left.observableKey === correctKey) {
      degenerateAgainstCorrectModel.push({ hypothesisId: left.modelId, observableKey: left.observableKey });
    }
    for (let j = i + 1; j < misconceptions.length; j += 1) {
      const right = misconceptions[j]!;
      if (right.observableKey !== null && right.observableKey === left.observableKey) {
        const [a, b] = [left.modelId, right.modelId].sort();
        ambiguousPairs.push({ a: a!, b: b!, observableKey: left.observableKey });
      }
    }
  }
  if (ambiguousPairs.length) issues.add("ambiguous_hypothesis_pair");
  if (degenerateAgainstCorrectModel.length) issues.add("degenerate_against_correct_model");

  return {
    probeId: spec.probeId,
    distinguishable: issues.size === 0,
    predictions,
    ambiguousPairs: ambiguousPairs.sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b)),
    degenerateAgainstCorrectModel: degenerateAgainstCorrectModel.sort((x, y) => x.hypothesisId.localeCompare(y.hypothesisId)),
    issues: [...issues].sort(),
  };
}

export interface ProbeResponseClassification {
  observableKey: string | null;
  match: { role: "correct" | "misconception"; modelId: string } | null;
  wellFormed: boolean;
}

/**
 * Attribute a learner response to the unique model predicting it. Only meaningful for
 * probes that passed `verifyProbeDistinguishability`; ambiguous matches return null.
 */
export function classifyProbeResponse<TInput, TObservable>(
  spec: DistinguishableProbeSpec<TInput, TObservable>,
  response: unknown,
): ProbeResponseClassification {
  let observable: TObservable | null;
  try {
    observable = spec.parseResponse(response);
  } catch {
    observable = null;
  }
  if (observable === null) return { observableKey: null, match: null, wellFormed: false };
  const key = spec.observableKey(observable);
  const report = verifyProbeDistinguishability(spec);
  const matches = report.predictions.filter(row => row.observableKey === key);
  const only = matches.length === 1 ? matches[0]! : null;
  return { observableKey: key, wellFormed: true, match: only ? { role: only.role, modelId: only.modelId } : null };
}
