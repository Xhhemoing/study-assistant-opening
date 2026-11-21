import { cloneCartridgeData, readCartridgeDataProperty } from "./clone-cartridge-data";
import { cloneProbeDefinition, isClonedProbeDefinition, isNonBlankString, ProbeDefinitionError } from "./probe-definition";

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
  | "invalid_observable_key"
  | "nondeterministic_prediction"
  | "ambiguous_hypothesis_pair"
  | "degenerate_against_correct_model";

export interface ProbeModelPrediction {
  readonly modelId: string;
  readonly role: "correct" | "misconception";
  readonly observableKey: string | null;
}

export interface ProbeDistinguishabilityReport {
  readonly probeId: string;
  readonly distinguishable: boolean;
  readonly predictions: readonly ProbeModelPrediction[];
  /** Hypothesis pairs (ids sorted) that predict the same observable. */
  readonly ambiguousPairs: ReadonlyArray<Readonly<{ a: string; b: string; observableKey: string }>>;
  /** Hypotheses whose prediction equals the correct model's prediction. */
  readonly degenerateAgainstCorrectModel: ReadonlyArray<Readonly<{ hypothesisId: string; observableKey: string }>>;
  readonly issues: readonly ProbeDistinguishabilityIssue[];
}

export interface VerifiedProbeSnapshot<TObservable = unknown> {
  readonly probeId: string;
  readonly requirementKey: string;
  readonly report: ProbeDistinguishabilityReport;
  /** Populated only when `report.distinguishable` is true. */
  readonly correctObservableKey: string | null;
  readonly observableKey: ((observable: TObservable) => string) | null;
  readonly parseResponse: ((response: unknown) => TObservable | null) | null;
}

interface PrivateSnapshotState<TObservable = unknown> {
  readonly distinguishable: boolean;
  readonly correctModelId: string;
  readonly correctObservableKey: string | null;
  readonly hypothesisByObservableKey: ReadonlyMap<string, string>;
  readonly observableKey: ((observable: TObservable) => string) | null;
  readonly parseResponse: ((response: unknown) => TObservable | null) | null;
}

/** Module-private lookup state so callers cannot mutate the snapshot's scoring table. */
const SNAPSHOT_STATE = new WeakMap<VerifiedProbeSnapshot<unknown>, PrivateSnapshotState<unknown>>();

export function isVerifiedProbeSnapshot<TObservable>(snapshot: VerifiedProbeSnapshot<TObservable>): boolean {
  return SNAPSHOT_STATE.has(snapshot as VerifiedProbeSnapshot<unknown>);
}

/** Runtime guard: observable keys must be non-empty, non-whitespace strings. */
export const isValidObservableKey = isNonBlankString;

function predictKey<TInput, TObservable>(
  input: TInput,
  encodeObservable: (observable: TObservable) => string,
  predict: (value: TInput) => TObservable,
  issues: Set<ProbeDistinguishabilityIssue>,
): string | null {
  try {
    const predictAndEncode = (): unknown => {
      const inputCopy = structuredClone(input);
      return encodeObservable(cloneCartridgeData(predict(inputCopy)));
    };
    const first = predictAndEncode();
    const second = predictAndEncode();
    if (!isValidObservableKey(first) || !isValidObservableKey(second)) {
      issues.add("invalid_observable_key");
      return null;
    }
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

function readProbeIdentity(spec: unknown, key: "probeId" | "requirementKey"): string {
  try {
    const value = readCartridgeDataProperty(spec, key);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function invalidProbeSnapshot<TObservable>(
  spec: unknown,
  issue: ProbeDistinguishabilityIssue,
): VerifiedProbeSnapshot<TObservable> {
  const probeId = readProbeIdentity(spec, "probeId");
  const report: ProbeDistinguishabilityReport = Object.freeze({
    probeId,
    distinguishable: false,
    predictions: Object.freeze([]),
    ambiguousPairs: Object.freeze([]),
    degenerateAgainstCorrectModel: Object.freeze([]),
    issues: Object.freeze([issue]),
  });
  const snapshot: VerifiedProbeSnapshot<TObservable> = Object.freeze({
    probeId,
    requirementKey: readProbeIdentity(spec, "requirementKey"),
    report,
    correctObservableKey: null,
    observableKey: null,
    parseResponse: null,
  });
  SNAPSHOT_STATE.set(snapshot as VerifiedProbeSnapshot<unknown>, Object.freeze({
    distinguishable: false,
    correctModelId: "",
    correctObservableKey: null,
    hypothesisByObservableKey: new Map<string, string>(),
    observableKey: null,
    parseResponse: null,
  }));
  return snapshot;
}

/**
 * Capture a single immutable snapshot of a probe's identity, predictions and encoded
 * observable keys, then run the H_i != H_j / H_i != M* distinguishability pre-check
 * strictly against that snapshot.
 */
export function snapshotAndVerifyProbe<TInput, TObservable>(
  spec: DistinguishableProbeSpec<TInput, TObservable>,
): VerifiedProbeSnapshot<TObservable> {
  let probe: DistinguishableProbeSpec<TInput, TObservable>;
  try {
    probe = isClonedProbeDefinition(spec) ? spec : cloneProbeDefinition(spec);
  } catch (error) {
    return invalidProbeSnapshot(spec, error instanceof ProbeDefinitionError ? error.issue : "prediction_failed");
  }
  const { probeId, requirementKey, input, correctModel, hypotheses } = probe;
  const encodeObservable = (observable: TObservable) => probe.observableKey(observable);
  const parseResponse = (response: unknown) => probe.parseResponse(response);
  const issues = new Set<ProbeDistinguishabilityIssue>();
  const ids = [correctModel.id, ...hypotheses.map(model => model.id)];
  if (new Set(ids).size !== ids.length) issues.add("duplicate_model_id");

  const correctKey = predictKey(input, encodeObservable, value => correctModel.predict(value), issues);
  const predictions: ProbeModelPrediction[] = [
    Object.freeze({ modelId: correctModel.id, role: correctModel.role, observableKey: correctKey }),
    ...hypotheses.map(hypothesis => Object.freeze({
      modelId: hypothesis.id,
      role: hypothesis.role,
      observableKey: predictKey(input, encodeObservable, value => hypothesis.predict(value), issues),
    })),
  ];

  const ambiguousPairs: Array<ProbeDistinguishabilityReport["ambiguousPairs"][number]> = [];
  const degenerateAgainstCorrectModel: Array<ProbeDistinguishabilityReport["degenerateAgainstCorrectModel"][number]> = [];
  // One lookup per hypothesis. Only enumerate pairs that will appear in the report.
  const hypothesesByKey = new Map<string, string[]>();
  for (const { modelId, observableKey } of predictions.slice(1)) {
    if (observableKey === null) continue;
    if (observableKey === correctKey) {
      degenerateAgainstCorrectModel.push(Object.freeze({ hypothesisId: modelId, observableKey }));
    }
    const previous = hypothesesByKey.get(observableKey);
    if (!previous) {
      hypothesesByKey.set(observableKey, [modelId]);
      continue;
    }
    for (const other of previous) {
      const [a, b] = other < modelId ? [other, modelId] : [modelId, other];
      ambiguousPairs.push(Object.freeze({ a, b, observableKey }));
    }
    previous.push(modelId);
  }
  if (ambiguousPairs.length) issues.add("ambiguous_hypothesis_pair");
  if (degenerateAgainstCorrectModel.length) issues.add("degenerate_against_correct_model");

  const distinguishable = issues.size === 0;
  const report: ProbeDistinguishabilityReport = Object.freeze({
    probeId,
    distinguishable,
    predictions: Object.freeze(predictions),
    ambiguousPairs: Object.freeze(
      ambiguousPairs.sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b)),
    ),
    degenerateAgainstCorrectModel: Object.freeze(
      degenerateAgainstCorrectModel.sort((x, y) => x.hypothesisId.localeCompare(y.hypothesisId)),
    ),
    issues: Object.freeze([...issues].sort()),
  });

  const hypothesisByObservableKey = new Map<string, string>();
  if (distinguishable) {
    for (const [key, [modelId]] of hypothesesByKey) {
      hypothesisByObservableKey.set(key, modelId!);
    }
  }

  const correctObservableKey = distinguishable ? correctKey : null;
  const snapshot: VerifiedProbeSnapshot<TObservable> = Object.freeze({
    probeId,
    requirementKey,
    report,
    correctObservableKey,
    observableKey: Object.freeze((observable: TObservable) => {
      const key = encodeObservable(cloneCartridgeData(observable));
      if (!isValidObservableKey(key)) throw new TypeError("Cartridge observable key must be a non-blank string");
      return key;
    }),
    parseResponse: Object.freeze((response: unknown) =>
      cloneCartridgeData(parseResponse(cloneCartridgeData(response)))),
  });
  SNAPSHOT_STATE.set(snapshot as VerifiedProbeSnapshot<unknown>, Object.freeze({
    distinguishable,
    correctModelId: correctModel.id,
    correctObservableKey,
    hypothesisByObservableKey,
    observableKey: encodeObservable as ((observable: unknown) => string) | null,
    parseResponse: parseResponse as ((response: unknown) => unknown) | null,
  }));
  return snapshot;
}

/** Deterministic H_A != H_B and H_i != M* pre-check for a single probe input. */
export function verifyProbeDistinguishability<TInput, TObservable>(
  spec: DistinguishableProbeSpec<TInput, TObservable>,
): ProbeDistinguishabilityReport {
  return snapshotAndVerifyProbe(spec).report;
}

export interface ProbeResponseClassification {
  observableKey: string | null;
  match: { role: "correct" | "misconception"; modelId: string } | null;
  wellFormed: boolean;
}

export interface SnapshotResponseClassification {
  classification: ProbeResponseClassification;
  /** True when a parsed observable cannot be isolated or encoded to a stable, valid key. */
  encodingFailed: boolean;
}

/**
 * Attribute a learner response against an already-captured immutable probe snapshot.
 * Never re-invokes model predictors; rejects non-string/empty observable keys and
 * never attributes a match when the snapshot failed distinguishability verification.
 */
export function classifyProbeResponseWithSnapshot<TObservable>(
  snapshot: VerifiedProbeSnapshot<TObservable>,
  response: unknown,
): SnapshotResponseClassification {
  const priv = snapshot && typeof snapshot === "object"
    ? SNAPSHOT_STATE.get(snapshot as VerifiedProbeSnapshot<unknown>)
    : undefined;
  if (!priv || !priv.parseResponse || !priv.observableKey) {
    return { classification: { observableKey: null, match: null, wellFormed: false }, encodingFailed: true };
  }
  let observable: unknown;
  try {
    observable = priv.parseResponse(cloneCartridgeData(response));
  } catch {
    observable = null;
  }
  if (observable === null || observable === undefined) {
    return { classification: { observableKey: null, match: null, wellFormed: false }, encodingFailed: false };
  }
  let key: unknown;
  try {
    const captured = cloneCartridgeData(observable);
    const first = priv.observableKey(structuredClone(captured));
    const second = priv.observableKey(captured);
    key = first === second ? first : null;
  } catch {
    return { classification: { observableKey: null, match: null, wellFormed: false }, encodingFailed: true };
  }
  if (!isValidObservableKey(key)) {
    return { classification: { observableKey: null, match: null, wellFormed: false }, encodingFailed: true };
  }
  if (!priv.distinguishable || priv.correctObservableKey === null) {
    return { classification: { observableKey: key, wellFormed: true, match: null }, encodingFailed: false };
  }
  if (key === priv.correctObservableKey) {
    return {
      classification: { observableKey: key, wellFormed: true, match: { role: "correct", modelId: priv.correctModelId } },
      encodingFailed: false,
    };
  }
  const matchedHypothesisId = priv.hypothesisByObservableKey.get(key) ?? null;
  return {
    classification: {
      observableKey: key,
      wellFormed: true,
      match: matchedHypothesisId ? { role: "misconception", modelId: matchedHypothesisId } : null,
    },
    encodingFailed: false,
  };
}

/**
 * Attribute a learner response to the unique model predicting it. Only meaningful for
 * probes that passed `verifyProbeDistinguishability`; ambiguous matches return null.
 */
export function classifyProbeResponse<TInput, TObservable>(
  spec: DistinguishableProbeSpec<TInput, TObservable>,
  response: unknown,
): ProbeResponseClassification {
  return classifyProbeResponseWithSnapshot(snapshotAndVerifyProbe(spec), response).classification;
}
