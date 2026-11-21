import { logSumExp } from "../epistemic/gauss-hermite";
import {
  binaryEntropyBits,
  isUnassistedValidObservation,
  validateKstSnapshot,
  validateProbeItem,
  validateSkillGraph,
  type ValidatedSkillGraph,
} from "./kst-state-space";
import {
  DiagnosticPlacementError,
  INTEGRATION_STEP_COORDINATION,
  MAX_TOTAL_DRILLDOWN_PROBES,
  type DiagnosticProbeItem,
  type DiagnosticProbeObservation,
  type DiagnosticSkillNode,
  type DrilldownHypothesisPosterior,
  type DrilldownRootCause,
  type DrilldownStatus,
  type FrozenOriginalContext,
  type KstSnapshotV1,
  type RepairPlanStep,
} from "./types";

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
type Hypothesis = { id: string; kind: DrilldownRootCause; skillId: string | null };

export type PrerequisiteDrilldownInput = {
  skills: readonly DiagnosticSkillNode[];
  targetSkillId: string;
  probePool: readonly DiagnosticProbeItem[];
  originalContext: FrozenOriginalContext;
  /** Caller values > 2 are clamped to MAX_TOTAL_DRILLDOWN_PROBES (2). */
  maxProbes?: number;
  kstSnapshot?: KstSnapshotV1;
};

export type DrilldownProbeSelection = {
  status: DrilldownStatus;
  probe: DiagnosticProbeItem | null;
  mutualInformationBits: number | null;
  probesAdministered: number;
  remainingProbes: number;
};

export type DrilldownStateSnapshot = {
  status: DrilldownStatus;
  rootCause: DrilldownRootCause | null;
  targetSkillId: string;
  maxTotalProbes: number;
  probesAdministered: number;
  confirmedDeficitSkillIds: readonly string[];
  posteriors: readonly DrilldownHypothesisPosterior[];
  repairPlan: readonly RepairPlanStep[];
  restoreContext: FrozenOriginalContext | null;
};

function freezeOriginalContext(ctx: FrozenOriginalContext): FrozenOriginalContext {
  if (!ctx.originalAttemptId.trim() || !ctx.originalItemId.trim()) {
    throw new DiagnosticPlacementError("VALIDATION", "originalAttemptId and originalItemId must be non-empty");
  }
  if (!Number.isFinite(ctx.frozenCursorOffset) || ctx.frozenCursorOffset < 0 || !Number.isFinite(ctx.startedAtMs)) {
    throw new DiagnosticPlacementError("VALIDATION", "frozenCursorOffset and startedAtMs must be valid finite numbers");
  }
  return Object.freeze({ ...ctx });
}

export class PrerequisiteDrilldownStateMachine {
  readonly graph: ValidatedSkillGraph;
  readonly targetSkillId: string;
  readonly maxTotalProbes: number;

  private readonly frozenContext: FrozenOriginalContext;
  private readonly prerequisitesInTopoOrder: readonly string[];
  private readonly prerequisiteSet: ReadonlySet<string>;
  private readonly probePool: readonly DiagnosticProbeItem[];
  private readonly probeById = new Map<string, DiagnosticProbeItem>();
  private readonly hypotheses: readonly Hypothesis[];
  private readonly logWeights: Float64Array;
  private readonly weights: Float64Array;

  private readonly usedItemIds = new Set<string>();
  private readonly usedFamilyIds = new Set<string>();
  private readonly seenObservationIds = new Set<string>();

  private status: DrilldownStatus = "probing";
  private rootCause: DrilldownRootCause | null = null;
  private confirmedDeficitSkillIds: string[] = [];
  private repairPlan: RepairPlanStep[] = [];
  private probesAdministered = 0;
  private unassistedCorrectCount = 0;
  private hadNonUnassistedProbe = false;
  private pendingProbeId: string | null = null;

  constructor(input: PrerequisiteDrilldownInput) {
    this.graph = validateSkillGraph(input.skills);
    const target = this.graph.skillsById.get(input.targetSkillId);
    if (!target) throw new DiagnosticPlacementError("VALIDATION", `Unknown targetSkillId ${input.targetSkillId}`);
    this.targetSkillId = input.targetSkillId;
    this.frozenContext = freezeOriginalContext(input.originalContext);

    const reqMax = input.maxProbes ?? MAX_TOTAL_DRILLDOWN_PROBES;
    this.maxTotalProbes = Math.min(MAX_TOTAL_DRILLDOWN_PROBES, Math.max(1, Number.isFinite(reqMax) ? Math.floor(reqMax) : MAX_TOTAL_DRILLDOWN_PROBES));
    this.prerequisitesInTopoOrder = this.graph.topoOrder.filter(id => target.ancestorIds.has(id));
    this.prerequisiteSet = new Set(this.prerequisitesInTopoOrder);

    for (const probe of input.probePool) {
      if (this.probeById.has(probe.itemId)) throw new DiagnosticPlacementError("VALIDATION", `Duplicate drilldown probe itemId ${probe.itemId}`);
      validateProbeItem(probe, this.graph.skillsById);
      this.probeById.set(probe.itemId, probe);
    }
    this.probePool = input.probePool;

    this.hypotheses = [
      ...this.prerequisitesInTopoOrder.map(skillId => ({ id: skillId, kind: "prerequisite_deficit" as const, skillId })),
      { id: INTEGRATION_STEP_COORDINATION, kind: INTEGRATION_STEP_COORDINATION, skillId: null },
    ];
    this.logWeights = new Float64Array(this.hypotheses.length);
    this.weights = new Float64Array(this.hypotheses.length);
    for (let i = 0; i < this.hypotheses.length; i++) {
      const h = this.hypotheses[i]!;
      const prior = !input.kstSnapshot ? 1
        : (validateKstSnapshot(input.kstSnapshot), h.kind === INTEGRATION_STEP_COORDINATION ? Math.max(0.05, input.kstSnapshot.parentsSatisfiedBySkill[this.targetSkillId] ?? 0.5)
        : Math.max(0.05, 1 - (input.kstSnapshot.piBySkill[h.skillId!] ?? 0.5)));
      this.logWeights[i] = Math.log(prior);
    }
    this.renormalize();

    if (this.prerequisitesInTopoOrder.length === 0) this.transitionToRestoreOriginal();
  }

  private renormalize(): boolean {
    const denom = logSumExp(Array.from(this.logWeights));
    if (!Number.isFinite(denom)) return false;
    for (let i = 0; i < this.logWeights.length; i++) {
      this.logWeights[i] = this.logWeights[i]! - denom;
      this.weights[i] = Math.exp(this.logWeights[i]!);
    }
    return true;
  }

  private successProbUnderHypothesis(probe: DiagnosticProbeItem, h: Hypothesis): number {
    if (h.kind === INTEGRATION_STEP_COORDINATION) return 1 - probe.slip;
    const deficitId = h.skillId!;
    const blocked = probe.requiredSkillIds.some(r => r === deficitId || (this.graph.skillsById.get(r)?.ancestorIds.has(deficitId) ?? false));
    return blocked ? probe.guess : 1 - probe.slip;
  }

  computeProbeMutualInformation(probe: DiagnosticProbeItem): number {
    validateProbeItem(probe, this.graph.skillsById);
    let marginal = 0;
    let condEnt = 0;
    for (let i = 0; i < this.hypotheses.length; i++) {
      const w = this.weights[i]!;
      const r = this.successProbUnderHypothesis(probe, this.hypotheses[i]!);
      marginal += w * r;
      condEnt += w * binaryEntropyBits(r);
    }
    return Math.max(0, binaryEntropyBits(marginal) - condEnt);
  }

  private eligibleUnusedProbes(): DiagnosticProbeItem[] {
    return this.probePool.filter(p =>
      !this.usedItemIds.has(p.itemId) && !this.usedFamilyIds.has(p.familyId) &&
      p.requiredSkillIds.length > 0 && p.requiredSkillIds.every(id => this.prerequisiteSet.has(id)));
  }

  private transitionToRestoreOriginal(): void {
    this.status = "restore_original_attempt";
    this.rootCause = INTEGRATION_STEP_COORDINATION;
    this.confirmedDeficitSkillIds = [];
    this.pendingProbeId = null;
    this.repairPlan = [{ stepIndex: 0, kind: "restore_original_attempt", skillId: this.targetSkillId, itemId: this.frozenContext.originalItemId, label: `Restore ${this.targetSkillId}` }];
  }

  private transitionToRepairPlan(): void {
    let bestDeficit = this.prerequisitesInTopoOrder[0]!;
    let bestWeight = -1;
    for (let i = 0; i < this.hypotheses.length; i++) {
      const h = this.hypotheses[i]!;
      if (h.kind === "prerequisite_deficit" && this.weights[i]! > bestWeight + 1e-12) {
        bestWeight = this.weights[i]!;
        bestDeficit = h.skillId!;
      }
    }
    const bridging = this.prerequisitesInTopoOrder.filter(id => id !== bestDeficit && this.graph.skillsById.get(id)!.ancestorIds.has(bestDeficit));
    this.status = "repair_plan_ready";
    this.rootCause = "prerequisite_deficit";
    this.confirmedDeficitSkillIds = [bestDeficit];
    this.pendingProbeId = null;
    this.repairPlan = [
      { stepIndex: 0, kind: "foundational_prerequisite", skillId: bestDeficit, itemId: null, label: `Repair foundational prerequisite ${bestDeficit}` },
      ...bridging.map((skillId, idx) => ({ stepIndex: idx + 1, kind: "bridging_step" as const, skillId, itemId: null, label: `Bridge prerequisite ${skillId}` })),
      { stepIndex: bridging.length + 1, kind: "restore_original_attempt", skillId: this.targetSkillId, itemId: this.frozenContext.originalItemId, label: `Restore ${this.targetSkillId}` },
    ];
  }

  private finalizeOutcome(): void {
    if (this.probesAdministered > 0 && this.unassistedCorrectCount === this.probesAdministered && !this.hadNonUnassistedProbe) {
      this.transitionToRestoreOriginal();
    } else {
      this.transitionToRepairPlan();
    }
  }

  selectNextProbe(): DrilldownProbeSelection {
    if (this.status !== "probing") {
      return { status: this.status, probe: null, mutualInformationBits: null, probesAdministered: this.probesAdministered, remainingProbes: 0 };
    }
    if (this.pendingProbeId) {
      const pending = this.probeById.get(this.pendingProbeId);
      if (pending && !this.usedItemIds.has(pending.itemId) && !this.usedFamilyIds.has(pending.familyId)
        && pending.requiredSkillIds.length > 0 && pending.requiredSkillIds.every(id => this.prerequisiteSet.has(id))) {
        return { status: this.status, probe: pending, mutualInformationBits: this.computeProbeMutualInformation(pending), probesAdministered: this.probesAdministered, remainingProbes: Math.max(0, this.maxTotalProbes - this.probesAdministered) };
      }
      this.pendingProbeId = null;
    }
    const candidates = this.probesAdministered < this.maxTotalProbes ? this.eligibleUnusedProbes() : [];
    if (candidates.length === 0) {
      this.finalizeOutcome();
      return { status: this.status, probe: null, mutualInformationBits: null, probesAdministered: this.probesAdministered, remainingProbes: 0 };
    }
    let bestProbe = candidates[0]!;
    let bestMi = this.computeProbeMutualInformation(bestProbe);
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i]!;
      const mi = this.computeProbeMutualInformation(c);
      if (mi > bestMi + 1e-12 || (Math.abs(mi - bestMi) <= 1e-12 && cmpStr(c.itemId, bestProbe.itemId) < 0)) {
        bestProbe = c;
        bestMi = mi;
      }
    }
    if (this.probesAdministered > 0 && bestMi <= 1e-12) {
      this.finalizeOutcome();
      return { status: this.status, probe: null, mutualInformationBits: null, probesAdministered: this.probesAdministered, remainingProbes: 0 };
    }
    this.pendingProbeId = bestProbe.itemId;
    return { status: this.status, probe: bestProbe, mutualInformationBits: bestMi, probesAdministered: this.probesAdministered, remainingProbes: Math.max(0, this.maxTotalProbes - this.probesAdministered) };
  }

  recordProbeResponse(observation: DiagnosticProbeObservation): DrilldownStateSnapshot {
    if (!observation.observationId.trim()) throw new DiagnosticPlacementError("VALIDATION", "observationId must be non-empty");
    if (this.seenObservationIds.has(observation.observationId)) return this.getState();
    if (this.status !== "probing" || this.probesAdministered >= this.maxTotalProbes) {
      throw new DiagnosticPlacementError("INVALID_STATE", `Drilldown hard cap (${MAX_TOTAL_DRILLDOWN_PROBES}) reached or already finalized`);
    }
    const probe = this.probeById.get(observation.itemId);
    if (!probe) throw new DiagnosticPlacementError("VALIDATION", `Unknown drilldown probe itemId ${observation.itemId}`);
    if (probe.requiredSkillIds.length === 0 || !probe.requiredSkillIds.every(id => this.prerequisiteSet.has(id))) {
      throw new DiagnosticPlacementError("VALIDATION", `Drilldown probe ${probe.itemId} must target only prerequisites of ${this.targetSkillId}`);
    }
    if (this.usedItemIds.has(probe.itemId)) {
      throw new DiagnosticPlacementError("VALIDATION", `Drilldown probe itemId ${probe.itemId} has already been used`);
    }
    if (this.usedFamilyIds.has(probe.familyId)) {
      throw new DiagnosticPlacementError("VALIDATION", `Drilldown probe familyId ${probe.familyId} has already been used`);
    }

    this.seenObservationIds.add(observation.observationId);
    this.usedItemIds.add(probe.itemId);
    this.usedFamilyIds.add(probe.familyId);
    this.pendingProbeId = null;
    this.probesAdministered += 1;

    if (isUnassistedValidObservation(observation)) {
      const savedLogW = this.logWeights.slice();
      const savedW = this.weights.slice();
      for (let i = 0; i < this.hypotheses.length; i++) {
        const p1 = this.successProbUnderHypothesis(probe, this.hypotheses[i]!);
        const like = observation.correct ? p1 : 1 - p1;
        this.logWeights[i] = this.logWeights[i]! + (like > 0 ? Math.log(like) : -Infinity);
      }
      if (!this.renormalize()) { this.logWeights.set(savedLogW); this.weights.set(savedW); }
      if (observation.correct) this.unassistedCorrectCount += 1;
    } else {
      this.hadNonUnassistedProbe = true;
    }

    const canContinue = this.probesAdministered < this.maxTotalProbes &&
      this.eligibleUnusedProbes().some(c => this.computeProbeMutualInformation(c) > 1e-12);
    if (!canContinue) this.finalizeOutcome();
    return this.getState();
  }

  getFrozenOriginalContext = (): FrozenOriginalContext => Object.freeze({ ...this.frozenContext });
  getRepairPlan = (): readonly RepairPlanStep[] => this.repairPlan.map(step => ({ ...step }));
  restoreOriginalAttempt = (): FrozenOriginalContext => this.getFrozenOriginalContext();

  getState(): DrilldownStateSnapshot {
    return {
      status: this.status,
      rootCause: this.rootCause,
      targetSkillId: this.targetSkillId,
      maxTotalProbes: this.maxTotalProbes,
      probesAdministered: this.probesAdministered,
      confirmedDeficitSkillIds: [...this.confirmedDeficitSkillIds],
      posteriors: this.hypotheses.map((h, i) => ({ hypothesisId: h.id, kind: h.kind, skillId: h.skillId, probability: this.weights[i]! })),
      repairPlan: this.getRepairPlan(),
      restoreContext: this.status === "restore_original_attempt" ? this.getFrozenOriginalContext() : null,
    };
  }
}
