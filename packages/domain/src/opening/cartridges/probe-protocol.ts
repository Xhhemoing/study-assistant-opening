import { cloneCartridgeData } from "./clone-cartridge-data";

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

/** Runtime guard: observable keys must be non-empty, non-whitespace strings. */
export function isValidObservableKey(key: unknown): key is string {
  return typeof key === "string" && key.trim().length > 0;
}

type ReadResult<T> = { ok: true; value: T } | { ok: false };

function safeRead<T>(getter: () => T): ReadResult<T> {
  try {
    return { ok: true, value: getter() };
  } catch {
    return { ok: false };
  }
}

function predictKey<TInput, TObservable>(
  input: ReadResult<TInput>,
  encodeObservable: ((observable: TObservable) => string) | null,
  predict: ((value: TInput) => TObservable) | null,
  issues: Set<ProbeDistinguishabilityIssue>,
): string | null {
  if (!input.ok || !encodeObservable || !predict) {
    issues.add("prediction_failed");
    return null;
  }
  try {
    const predictAndEncode = (): unknown => {
      const inputCopy = structuredClone(input.value);
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

interface CapturedModel<TInput, TObservable> {
  id: string;
  predict: ((input: TInput) => TObservable) | null;
}

function captureModel<TInput, TObservable>(raw: unknown): CapturedModel<TInput, TObservable> {
  if (!raw || typeof raw !== "object") return { id: "", predict: null };
  const candidate = raw as Partial<ObservableModel<TInput, TObservable>>;
  const idRead = safeRead(() => candidate.id);
  const predictRead = safeRead(() => candidate.predict);
  return {
    id: idRead.ok && typeof idRead.value === "string" ? idRead.value : "",
    predict: predictRead.ok && typeof predictRead.value === "function"
      ? (value: TInput) => predictRead.value!.call(raw, value)
      : null,
  };
}

/**
 * Capture a single immutable snapshot of a probe's identity, predictions and encoded
 * observable keys, then run the H_i != H_j / H_i != M* distinguishability pre-check
 * strictly against that snapshot.
 */
export function snapshotAndVerifyProbe<TInput, TObservable>(
  spec: DistinguishableProbeSpec<TInput, TObservable>,
): VerifiedProbeSnapshot<TObservable> {
  const issues = new Set<ProbeDistinguishabilityIssue>();
  if (!spec || typeof spec !== "object") {
    issues.add("probe_identity_incomplete");
    issues.add("no_competing_hypotheses");
    const report: ProbeDistinguishabilityReport = Object.freeze({
      probeId: "",
      distinguishable: false,
      predictions: Object.freeze([]),
      ambiguousPairs: Object.freeze([]),
      degenerateAgainstCorrectModel: Object.freeze([]),
      issues: Object.freeze([...issues].sort()),
    });
    const snapshot: VerifiedProbeSnapshot<TObservable> = Object.freeze({
      probeId: "",
      requirementKey: "",
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

  const probeIdRead = safeRead(() => spec.probeId);
  const requirementKeyRead = safeRead(() => spec.requirementKey);
  const inputRead = safeRead(() => cloneCartridgeData(spec.input));
  const correctRead = safeRead(() => spec.correctModel);
  const hypothesesRead = safeRead(() => spec.hypotheses);
  const encodeRead = safeRead(() => spec.observableKey);
  const parseRead = safeRead(() => spec.parseResponse);

  const probeId = probeIdRead.ok && typeof probeIdRead.value === "string" ? probeIdRead.value : "";
  const requirementKey = requirementKeyRead.ok && typeof requirementKeyRead.value === "string" ? requirementKeyRead.value : "";
  const encodeObservable = encodeRead.ok && typeof encodeRead.value === "function"
    ? Object.freeze((observable: TObservable) => encodeRead.value!.call(spec, observable))
    : null;
  const parseResponse = parseRead.ok && typeof parseRead.value === "function"
    ? Object.freeze((response: unknown) => parseRead.value!.call(spec, response))
    : null;

  const correctModel = correctRead.ok ? captureModel<TInput, TObservable>(correctRead.value) : { id: "", predict: null };
  if (!isValidObservableKey(probeId) || !isValidObservableKey(requirementKey) || !isValidObservableKey(correctModel.id)) {
    issues.add("probe_identity_incomplete");
  }
  if (!parseResponse) issues.add("probe_identity_incomplete");
  if (!inputRead.ok || !encodeObservable) issues.add("prediction_failed");

  let rawHypotheses: unknown[] = [];
  if (hypothesesRead.ok && Array.isArray(hypothesesRead.value)) {
    const copyRead = safeRead(() => [...hypothesesRead.value]);
    if (copyRead.ok) rawHypotheses = copyRead.value;
    else issues.add("prediction_failed");
  } else if (!hypothesesRead.ok) {
    issues.add("prediction_failed");
  }
  const hypotheses = rawHypotheses.map(item => captureModel<TInput, TObservable>(item));
  if (hypotheses.length === 0) issues.add("no_competing_hypotheses");

  const ids = [correctModel.id, ...hypotheses.map(row => row.id)];
  if (new Set(ids).size !== ids.length || ids.some(id => !isValidObservableKey(id))) {
    issues.add("duplicate_model_id");
  }

  const correctKey = predictKey(inputRead, encodeObservable, correctModel.predict, issues);
  const predictions: ProbeModelPrediction[] = [
    Object.freeze({ modelId: correctModel.id, role: "correct" as const, observableKey: correctKey }),
    ...hypotheses.map(hypothesis => Object.freeze({
      modelId: hypothesis.id,
      role: "misconception" as const,
      observableKey: predictKey(inputRead, encodeObservable, hypothesis.predict, issues),
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
    observableKey: encodeObservable,
    parseResponse,
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
