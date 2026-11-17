import type { Scope } from "@aistudy/contracts";
import type { NextLearningStep, NextLearningStepInput, SnapshotObservation } from "@aistudy/domain";
import type { ExperimentalBktAdviceInput, ExperimentalBktAdviceResult } from "../../../../packages/domain/src/opening/adaptive/experimental-bkt-advice";
import type { ExperimentalLearningAdvicePort } from "../features/opening/teaching/experimental-learning-advice-port";
import type {
  ExperimentalBktSnapshot, ExperimentalBktSnapshotInput,
} from "../../../../packages/database/src/repositories/opening-experimental-bkt-snapshot";

/** Server-only DI contract, NOT an authentication implementation or HTTP input.
 * The host must authenticate the current session, resolve resource ownership and
 * the exact target version on the server, and check experiment authorization.
 * No client-asserted principal, scope, target, cutoff or enablement is accepted.
 * Missing real host wiring must stay unavailable; this type is not proof of auth.
 */
export type ExperimentalBktTrustedHostContext = {
  scope: Scope;
  target: ExperimentalBktSnapshotInput;
  /** Host-resolved authoritative rule controls for THIS target/read. Observations
   * are never accepted here: the service uses this repository snapshot's heads.
   * Host must preserve priority facts omitted by experimental evidence filters
   * (due retest, requested explanation, phase, remediation, skill status).
   * Missing controls keep comparison unavailable; no defaults synthesize them.
   */
  ruleInput?: Omit<NextLearningStepInput, "observations">;
  /** Authoritative decision from the host's COMPLETE evidence/priority context.
   * Must agree with the experimental subset decision before comparison; otherwise
   * subset filtering may have removed an error/help/priority fact. No override.
   */
  ruleDecision?: NextLearningStep;
};
export type ExperimentalBktSnapshotHost = {
  resolveAuthenticatedContext(signal?: AbortSignal): Promise<ExperimentalBktTrustedHostContext | null>;
  /** Live, synchronous host-owned session/permission/resource-version check.
   * Must go false on logout, revocation, target change or stale host generation.
   * A previously returned context/stateVersion is never an authorization token.
   */
  isCurrent(context: ExperimentalBktTrustedHostContext): boolean;
  /** Explicit server-owned read-only prepare grant for this authenticated context.
   * Verify the live permission on each call. Not a caller boolean, context field,
   * persisted receipt or consequence of a repository approval. Missing = denied.
   * This seam cannot certify that a supplied host truly authenticates anything.
   */
  canPrepare?(context: ExperimentalBktTrustedHostContext): boolean;
  /** Separate live experiment permission; NOT implied by canPrepare or approval.
   * Checked before/after IO and after synchronous wrapper/port projection.
   */
  canCompare?(context: ExperimentalBktTrustedHostContext): boolean;
};
export type ExperimentalBktReadonlySnapshotRepository = {
  read(scope: Scope, input: ExperimentalBktSnapshotInput): Promise<ExperimentalBktSnapshot>;
};
/** No predictor implementation here. Any future wrapper binding must be separately
 * pinned to approved R4 (2b3d combination) with the exact R2 repository. It must be synchronous/pure, preserve
 * input isolation, propagate failures, and never make authorization/action writes.
 * The rule stays host-authoritative; comparison output cannot replace that rule.
 * The optional wrapper option is legacy compatibility only and is NOT executed.
 * Actual comparison will use the pinned real R4 function, not a caller substitute.
 */
export type ExperimentalBktSnapshotWrapper = (
  ruleInput: NextLearningStepInput, experiment: ExperimentalBktAdviceInput,
) => ExperimentalBktAdviceResult;
export type ExperimentalBktProviderQualification = {
  observationHeads: readonly SnapshotObservation[];
  experiment: Omit<ExperimentalBktAdviceInput, "enabled"> & { enabled: false };
  dataAsOf: string;
  stateVersion: string;
  /** Same-read heads + host controls; absent unless host supplied rule controls. */
  ruleInput?: NextLearningStepInput;
  ruleDecision?: NextLearningStep;
};
export type ExperimentalBktSnapshotServiceOptions = {
  host?: ExperimentalBktSnapshotHost;
  repository?: ExperimentalBktReadonlySnapshotRepository;
  /** Host-computed current rule, not a client-requested rule or wrapper result. */
  ruleDecision?: NextLearningStep;
  wrapper?: ExperimentalBktSnapshotWrapper;
};
export type ExperimentalBktSnapshotReadOptions = { enabled?: boolean; signal?: AbortSignal };
export type ExperimentalBktSnapshotServiceRead =
  | { status: "disabled" }
  | { status: "unavailable"; reason: string;
      /** R2-qualified data only: NOT wrapper/UI composition or comparison readiness.
       * Present only for blocked prepared data; never pass it as enabled input.
       */
      comparisonReady?: false;
      preparation?: { snapshot: ExperimentalBktSnapshot; qualification: ExperimentalBktProviderQualification;
        mode: "read_only"; authorization: "host_checked" } };
export type ExperimentalBktSnapshotPortRead = {
  /** True only for a successfully authorized DI comparison, never real host auth. */
  comparisonReady: boolean;
  reason: string;
  port: ExperimentalLearningAdvicePort | null;
};
