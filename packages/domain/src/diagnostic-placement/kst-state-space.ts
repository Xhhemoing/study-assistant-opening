import { createSkillBelief, type SkillBeliefV1 } from "../epistemic/belief";
import { logSumExp } from "../epistemic/gauss-hermite";
import {
  DiagnosticPlacementError,
  MAX_EXACT_KST_STATES,
  type DiagnosticProbeItem,
  type DiagnosticProbeObservation,
  type DiagnosticSkillNode,
  type DownstreamSkillPosteriorResult,
  type DownstreamSkillProbeObservation,
  type KstApproximationMode,
  type KstComponentJointWeights,
  type KstComponentMode,
  type KstObservationUpdateResult,
  type KstSnapshotV1,
  type PartitionedObservation,
  type PartitionedObservationsResult,
} from "./types";

const EPSILON = 1e-12;
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export type ValidatedSkillRecord = {
  skillId: string;
  chapterId: string;
  title?: string;
  prerequisiteIds: readonly string[];
  syllabusWeight: number;
  priorMastery: number;
  topoIndex: number;
  level: number;
  ancestorIds: ReadonlySet<string>;
};

export type ValidatedSkillGraph = {
  skillsById: ReadonlyMap<string, ValidatedSkillRecord>;
  topoOrder: readonly string[];
  components: readonly (readonly string[])[];
};

type ComponentSpace = {
  componentId: string;
  skillIds: readonly string[];
  localIndexBySkill: ReadonlyMap<string, number>;
  parentMasks: readonly bigint[];
  states: readonly bigint[];
  approximationMode: KstComponentMode;
  exactStateCountEstimate: number | null;
  logW: Float64Array;
  w: Float64Array;
};

export function canonicalStateKey(masteredSkillIds: readonly string[]): string {
  return JSON.stringify([...masteredSkillIds].sort(cmpStr));
}

export function binaryEntropyBits(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  return -(p * Math.log(p) + (1 - p) * Math.log1p(-p)) / Math.LN2;
}

export function isUnassistedValidObservation(obs: {
  correct: unknown;
  channel?: string;
  unassisted?: boolean;
  assisted?: boolean;
  hinted?: boolean;
  valid?: boolean;
}): boolean {
  return typeof obs.correct === "boolean" && obs.valid !== false && obs.assisted !== true
    && obs.hinted !== true && obs.unassisted !== false
    && (obs.channel === undefined || obs.channel === "unassisted");
}

export function validateProbeItem(probe: DiagnosticProbeItem, knownSkillIds: ReadonlyMap<string, unknown> | ReadonlySet<string>): void {
  if (!probe.itemId.trim() || !probe.familyId.trim() || !probe.chapterId.trim()) {
    throw new DiagnosticPlacementError("VALIDATION", "Probe itemId, familyId, and chapterId must be non-empty");
  }
  if (!Number.isFinite(probe.estimatedSeconds) || probe.estimatedSeconds <= 0) {
    throw new DiagnosticPlacementError("VALIDATION", `Probe ${probe.itemId} estimatedSeconds must be > 0`);
  }
  if (!Number.isFinite(probe.slip) || probe.slip < 0 || probe.slip >= 0.49
    || !Number.isFinite(probe.guess) || probe.guess < 0 || probe.guess >= 0.49 || !(1 - probe.slip > probe.guess)) {
    throw new DiagnosticPlacementError("VALIDATION", `Probe ${probe.itemId} must have slip, guess in [0, 0.49) and 1 - slip > guess`);
  }
  if (probe.requiredSkillIds.length === 0 || probe.requiredSkillIds.some(id => !knownSkillIds.has(id))) {
    throw new DiagnosticPlacementError("VALIDATION", `Probe ${probe.itemId} has empty or unknown requiredSkillIds`);
  }
}

export function validateSkillGraph(skills: readonly DiagnosticSkillNode[]): ValidatedSkillGraph {
  if (skills.length === 0) throw new DiagnosticPlacementError("VALIDATION", "Prerequisite graph must contain at least one skill");
  const rawById = new Map<string, { skillId: string; chapterId: string; title?: string; prerequisiteIds: string[]; syllabusWeight: number; priorMastery: number }>();
  for (const node of skills) {
    if (!node.skillId.trim() || !node.chapterId.trim()) throw new DiagnosticPlacementError("VALIDATION", "Skill skillId and chapterId must be non-empty");
    if (rawById.has(node.skillId)) throw new DiagnosticPlacementError("VALIDATION", `Duplicate skillId: ${node.skillId}`);
    const syllabusWeight = node.syllabusWeight ?? 0;
    const priorMastery = node.priorMastery ?? 0.5;
    if (!Number.isFinite(syllabusWeight) || syllabusWeight < 0) throw new DiagnosticPlacementError("VALIDATION", `Invalid syllabusWeight for ${node.skillId}`);
    if (!Number.isFinite(priorMastery) || priorMastery <= 0 || priorMastery >= 1) throw new DiagnosticPlacementError("VALIDATION", `Invalid priorMastery for ${node.skillId}`);
    rawById.set(node.skillId, { skillId: node.skillId, chapterId: node.chapterId, title: node.title, prerequisiteIds: [...new Set(node.prerequisiteIds ?? [])].sort(cmpStr), syllabusWeight, priorMastery });
  }

  const children = new Map<string, string[]>();
  const undirected = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of rawById.keys()) { children.set(id, []); undirected.set(id, []); indegree.set(id, 0); }

  for (const node of rawById.values()) {
    for (const parentId of node.prerequisiteIds) {
      if (parentId === node.skillId) throw new DiagnosticPlacementError("VALIDATION", `Self-loop prerequisite on ${node.skillId}`);
      if (!rawById.has(parentId)) throw new DiagnosticPlacementError("VALIDATION", `Unknown prerequisite ${parentId} referenced by ${node.skillId}`);
      children.get(parentId)!.push(node.skillId);
      undirected.get(parentId)!.push(node.skillId);
      undirected.get(node.skillId)!.push(parentId);
      indegree.set(node.skillId, indegree.get(node.skillId)! + 1);
    }
  }

  const ready = [...rawById.keys()].filter(id => indegree.get(id) === 0).sort(cmpStr);
  const topoOrder: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    topoOrder.push(id);
    for (const childId of children.get(id)!) {
      const next = indegree.get(childId)! - 1;
      indegree.set(childId, next);
      if (next === 0) { ready.push(childId); ready.sort(cmpStr); }
    }
  }
  if (topoOrder.length !== rawById.size) throw new DiagnosticPlacementError("VALIDATION", "Prerequisite graph contains a cycle");

  const skillsById = new Map<string, ValidatedSkillRecord>();
  topoOrder.forEach((skillId, topoIndex) => {
    const raw = rawById.get(skillId)!;
    const ancestorIds = new Set<string>();
    let level = 0;
    for (const parentId of raw.prerequisiteIds) {
      const p = skillsById.get(parentId)!;
      level = Math.max(level, p.level + 1);
      ancestorIds.add(parentId);
      for (const anc of p.ancestorIds) ancestorIds.add(anc);
    }
    skillsById.set(skillId, { ...raw, topoIndex, level, ancestorIds });
  });

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const seed of topoOrder) {
    if (visited.has(seed)) continue;
    const queue = [seed];
    const compSet = new Set<string>([seed]);
    visited.add(seed);
    for (let head = 0; head < queue.length; head++) {
      for (const nb of undirected.get(queue[head]!)!) {
        if (!visited.has(nb)) { visited.add(nb); compSet.add(nb); queue.push(nb); }
      }
    }
    components.push(topoOrder.filter(id => compSet.has(id)));
  }
  components.sort((a, b) => cmpStr(a[0]!, b[0]!));
  return { skillsById, topoOrder, components };
}

function enumerateDownsetsBounded(skillIds: readonly string[], graph: ValidatedSkillGraph, limit: number): { states: bigint[]; parentMasks: bigint[]; exceededLimit: boolean } {
  const localIdx = new Map(skillIds.map((id, i) => [id, i]));
  const parentMasks = skillIds.map(id => {
    let mask = 0n;
    for (const p of graph.skillsById.get(id)!.prerequisiteIds) {
      const idx = localIdx.get(p);
      if (idx !== undefined) mask |= 1n << BigInt(idx);
    }
    return mask;
  });
  const states: bigint[] = [];
  const stack: Array<{ idx: number; mask: bigint }> = [{ idx: 0, mask: 0n }];
  while (stack.length > 0) {
    const { idx, mask } = stack.pop()!;
    if (idx === skillIds.length) {
      states.push(mask);
      if (states.length > limit) return { states: [], parentMasks, exceededLimit: true };
      continue;
    }
    const pMask = parentMasks[idx]!;
    if ((mask & pMask) === pMask) stack.push({ idx: idx + 1, mask: mask | (1n << BigInt(idx)) });
    stack.push({ idx: idx + 1, mask });
  }
  states.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { states, parentMasks, exceededLimit: false };
}

function buildBoundedTopologicalEnvelope(skillIds: readonly string[], graph: ValidatedSkillGraph): bigint[] {
  const localIdx = new Map(skillIds.map((id, i) => [id, i]));
  const localLevel = new Map<string, number>();
  let maxLevel = 0;
  for (const id of skillIds) {
    const parents = graph.skillsById.get(id)!.prerequisiteIds;
    const lvl = parents.length === 0 ? 0 : 1 + Math.max(...parents.map(p => localLevel.get(p)!));
    localLevel.set(id, lvl);
    if (lvl > maxLevel) maxLevel = lvl;
  }
  const levels: number[][] = Array.from({ length: maxLevel + 1 }, () => []);
  skillIds.forEach((id, i) => levels[localLevel.get(id)!]!.push(i));

  const levelPrefix: bigint[] = [0n];
  for (let k = 0; k <= maxLevel; k++) {
    let mask = levelPrefix[k]!;
    for (const idx of levels[k]!) mask |= 1n << BigInt(idx);
    levelPrefix.push(mask);
  }

  const stateSet = new Set<bigint>();
  const tryAdd = (m: bigint): boolean => (stateSet.size >= MAX_EXACT_KST_STATES ? false : (stateSet.add(m), true));
  for (const frontier of levelPrefix) if (!tryAdd(frontier)) break;
  skillIds.forEach((id, idx) => {
    let aMask = 0n;
    for (const ancId of graph.skillsById.get(id)!.ancestorIds) {
      const aIdx = localIdx.get(ancId);
      if (aIdx !== undefined) aMask |= 1n << BigInt(aIdx);
    }
    tryAdd(aMask);
    tryAdd(aMask | (1n << BigInt(idx)));
  });
  for (let k = 0; k <= maxLevel; k++) {
    const base = levelPrefix[k]!;
    const next = levelPrefix[k + 1]!;
    for (const idx of levels[k]!) {
      const bit = 1n << BigInt(idx);
      if (!tryAdd(base | bit) || !tryAdd(next & ~bit)) break;
    }
  }

  const remaining = MAX_EXACT_KST_STATES - stateSet.size;
  if (remaining > 0) {
    const perLevelBudget = Math.max(1, Math.floor(remaining / (maxLevel + 1)));
    for (let k = 0; k <= maxLevel && stateSet.size < MAX_EXACT_KST_STATES; k++) {
      const nodes = levels[k]!;
      if (nodes.length <= 1) continue;
      const base = levelPrefix[k]!;
      let added = 0;
      const queue: Array<{ subMask: bigint; start: number }> = [{ subMask: 0n, start: 0 }];
      for (let head = 0; head < queue.length && added < perLevelBudget && stateSet.size < MAX_EXACT_KST_STATES; head++) {
        const { subMask, start } = queue[head]!;
        for (let i = start; i < nodes.length && added < perLevelBudget && stateSet.size < MAX_EXACT_KST_STATES; i++) {
          const nextSub = subMask | (1n << BigInt(nodes[i]!));
          const candidate = base | nextSub;
          if (!stateSet.has(candidate)) { stateSet.add(candidate); added++; }
          if (queue.length < perLevelBudget * 2) queue.push({ subMask: nextSub, start: i + 1 });
        }
      }
    }
  }
  return [...stateSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function normalizeLogWeights(logW: Float64Array, w: Float64Array): boolean {
  const denom = logSumExp(Array.from(logW));
  if (!Number.isFinite(denom)) return false;
  for (let i = 0; i < logW.length; i++) {
    const norm = logW[i]! - denom;
    logW[i] = norm;
    w[i] = Number.isFinite(norm) ? Math.exp(norm) : 0;
  }
  return true;
}

function buildComponentSpace(
  componentId: string,
  skillIds: readonly string[],
  graph: ValidatedSkillGraph,
  states: bigint[],
  parentMasks: bigint[],
  approximationMode: KstComponentMode,
  exactStateCountEstimate: number | null,
): ComponentSpace {
  const localIndexBySkill = new Map(skillIds.map((id, i) => [id, i]));
  const skillLogOdds = skillIds.map(id => {
    const p = graph.skillsById.get(id)!.priorMastery;
    return Math.log(p / (1 - p));
  });
  const logW = new Float64Array(states.length);
  const w = new Float64Array(states.length);
  for (let s = 0; s < states.length; s++) {
    let lp = 0;
    for (let k = 0; k < skillIds.length; k++) if ((states[s]! & (1n << BigInt(k))) !== 0n) lp += skillLogOdds[k]!;
    logW[s] = lp;
  }
  normalizeLogWeights(logW, w);
  return { componentId, skillIds, localIndexBySkill, parentMasks, states, approximationMode, exactStateCountEstimate, logW, w };
}

function validateProbabilityRecord(record: unknown, label: string, allowNegative = false): void {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new DiagnosticPlacementError("VALIDATION", `${label} must be a non-null record`);
  }
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new DiagnosticPlacementError("VALIDATION", `${label}[${key}] must be a finite number`);
    }
    if (!allowNegative && (value < 0 || value > 1)) {
      throw new DiagnosticPlacementError("VALIDATION", `${label}[${key}] must be within [0, 1]`);
    }
  }
}

export function validateKstSnapshot(snapshot: KstSnapshotV1): void {
  if (!snapshot || typeof snapshot !== "object" || snapshot.schemaVersion !== 1 || typeof snapshot.snapshotId !== "string" || !snapshot.snapshotId.trim()) {
    throw new DiagnosticPlacementError("VALIDATION", "Invalid KstSnapshotV1 header");
  }
  if (!Number.isFinite(snapshot.createdAtMs)) {
    throw new DiagnosticPlacementError("VALIDATION", "KstSnapshotV1 createdAtMs must be finite");
  }
  if (snapshot.totalFeasibleStateCount !== null && (!Number.isFinite(snapshot.totalFeasibleStateCount) || snapshot.totalFeasibleStateCount < 0)) {
    throw new DiagnosticPlacementError("VALIDATION", "KstSnapshotV1 totalFeasibleStateCount must be null or >= 0");
  }
  validateProbabilityRecord(snapshot.piBySkill, "piBySkill");
  validateProbabilityRecord(snapshot.outerFringeBySkill, "outerFringeBySkill");
  validateProbabilityRecord(snapshot.parentsSatisfiedBySkill, "parentsSatisfiedBySkill");
  if (snapshot.wByState !== null) {
    validateProbabilityRecord(snapshot.wByState, "wByState");
  }
  if (!Array.isArray(snapshot.componentJointWeights)) {
    throw new DiagnosticPlacementError("VALIDATION", "KstSnapshotV1 componentJointWeights must be an array");
  }
  snapshot.componentJointWeights.forEach((comp, idx) => {
    if (!comp || typeof comp !== "object") {
      throw new DiagnosticPlacementError("VALIDATION", `componentJointWeights[${idx}] must be an object`);
    }
    validateProbabilityRecord(comp.wByState, `componentJointWeights[${idx}].wByState`);
  });
  if (!snapshot.skillCovariance || typeof snapshot.skillCovariance !== "object" || Array.isArray(snapshot.skillCovariance)) {
    throw new DiagnosticPlacementError("VALIDATION", "KstSnapshotV1 skillCovariance must be a record");
  }
  for (const [skillId, row] of Object.entries(snapshot.skillCovariance)) {
    validateProbabilityRecord(row, `skillCovariance[${skillId}]`, true);
  }
  if (!Array.isArray(snapshot.consumedProbeObservationIds) || snapshot.consumedProbeObservationIds.some(id => typeof id !== "string")) {
    throw new DiagnosticPlacementError("VALIDATION", "KstSnapshotV1 consumedProbeObservationIds must be string[]");
  }
}

export class KstStateSpace {
  readonly graph: ValidatedSkillGraph;
  readonly approximationMode: KstApproximationMode;
  readonly totalFeasibleStateCount: number | null;
  readonly consumedProbeObservationIds: string[] = [];
  private _components: ComponentSpace[];
  private _componentIndexBySkill: Map<string, number>;
  private readonly seenObservationIds = new Set<string>();

  get components(): readonly ComponentSpace[] {
    return this._components;
  }

  get componentIndexBySkill(): ReadonlyMap<string, number> {
    return this._componentIndexBySkill;
  }

  constructor(skills: readonly DiagnosticSkillNode[]) {
    this.graph = validateSkillGraph(skills);
    const enumerated = this.graph.components.map((compSkills, i) => ({
      index: i, skillIds: compSkills, exact: enumerateDownsetsBounded(compSkills, this.graph, MAX_EXACT_KST_STATES),
    }));
    const anyExceeded = enumerated.some(e => e.exact.exceededLimit);
    let exactProduct = 1n;
    if (!anyExceeded) {
      for (const e of enumerated) exactProduct *= BigInt(e.exact.states.length);
    }
    const productWithinCap = !anyExceeded && exactProduct <= BigInt(MAX_EXACT_KST_STATES);
    const totalExactCount = !anyExceeded && exactProduct <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exactProduct) : null;

    if (productWithinCap) {
      this.approximationMode = "exact";
      this.totalFeasibleStateCount = totalExactCount;
      const fullExact = enumerateDownsetsBounded(this.graph.topoOrder, this.graph, MAX_EXACT_KST_STATES);
      this._components = [buildComponentSpace("comp-full", this.graph.topoOrder, this.graph, fullExact.states, fullExact.parentMasks, "exact", fullExact.states.length)];
    } else if (!anyExceeded) {
      this.approximationMode = "component_decomposed";
      this.totalFeasibleStateCount = totalExactCount;
      this._components = enumerated.map(e => buildComponentSpace(`comp-${e.index}`, e.skillIds, this.graph, e.exact.states, e.exact.parentMasks, "exact", e.exact.states.length));
    } else {
      this.approximationMode = "bounded_component_envelope";
      this.totalFeasibleStateCount = null;
      this._components = enumerated.map(e => e.exact.exceededLimit
        ? buildComponentSpace(`comp-${e.index}`, e.skillIds, this.graph, buildBoundedTopologicalEnvelope(e.skillIds, this.graph), e.exact.parentMasks, "bounded_component_envelope", null)
        : buildComponentSpace(`comp-${e.index}`, e.skillIds, this.graph, e.exact.states, e.exact.parentMasks, "exact", e.exact.states.length));
    }

    this._componentIndexBySkill = new Map<string, number>();
    this._components.forEach((c, idx) => c.skillIds.forEach(id => this._componentIndexBySkill.set(id, idx)));
  }

  private touchedMasks(requiredSkillIds: readonly string[]): Map<number, bigint> {
    const touched = new Map<number, bigint>();
    for (const skillId of requiredSkillIds) {
      const cIdx = this._componentIndexBySkill.get(skillId)!;
      const localIdx = this._components[cIdx]!.localIndexBySkill.get(skillId)!;
      touched.set(cIdx, (touched.get(cIdx) ?? 0n) | (1n << BigInt(localIdx)));
    }
    return touched;
  }

  private checkCrossComponentMerge(touchedIndices: readonly number[]): { feasible: true; productCount: number } | { feasible: false; reason: string } {
    if (touchedIndices.length <= 1) {
      return { feasible: true, productCount: touchedIndices.length === 1 ? this._components[touchedIndices[0]!]!.states.length : 1 };
    }
    let product = 1n;
    for (const cIdx of touchedIndices) {
      const comp = this._components[cIdx]!;
      if (comp.approximationMode !== "exact") {
        return { feasible: false, reason: `Cross-component probe touches ${comp.approximationMode} component ${comp.componentId}` };
      }
      product *= BigInt(comp.states.length);
      if (product > BigInt(MAX_EXACT_KST_STATES)) {
        return { feasible: false, reason: `Cross-component merge exceeds MAX_EXACT_KST_STATES (${MAX_EXACT_KST_STATES})` };
      }
    }
    return { feasible: true, productCount: Number(product) };
  }

  canEvaluateProbe(probe: DiagnosticProbeItem): boolean {
    if (probe.requiredSkillIds.length === 0 || probe.requiredSkillIds.some(id => !this.graph.skillsById.has(id))) {
      return false;
    }
    const touchedIndices = [...this.touchedMasks(probe.requiredSkillIds).keys()].sort((a, b) => a - b);
    return this.checkCrossComponentMerge(touchedIndices).feasible;
  }

  private buildMergedComponentCandidate(touchedIndices: readonly number[]): ComponentSpace {
    const touchedSet = new Set(touchedIndices);
    const mergedSkillIds = this.graph.topoOrder.filter(id => touchedSet.has(this._componentIndexBySkill.get(id)!));
    const localIndexBySkill = new Map(mergedSkillIds.map((id, i) => [id, i]));
    const parentMasks = mergedSkillIds.map(id => {
      let mask = 0n;
      for (const p of this.graph.skillsById.get(id)!.prerequisiteIds) {
        const idx = localIndexBySkill.get(p);
        if (idx !== undefined) mask |= 1n << BigInt(idx);
      }
      return mask;
    });

    const mappedByComp = touchedIndices.map(cIdx => {
      const comp = this._components[cIdx]!;
      const newBits = comp.skillIds.map(id => 1n << BigInt(localIndexBySkill.get(id)!));
      return comp.states.map(state => {
        let m = 0n;
        for (let k = 0; k < newBits.length; k++) if ((state & (1n << BigInt(k))) !== 0n) m |= newBits[k]!;
        return m;
      });
    });

    let prodStates: bigint[] = [0n];
    let prodLogW: number[] = [0];
    for (let r = 0; r < touchedIndices.length; r++) {
      const comp = this._components[touchedIndices[r]!]!;
      const mapped = mappedByComp[r]!;
      const nextStates = new Array<bigint>(prodStates.length * mapped.length);
      const nextLogW = new Array<number>(prodLogW.length * mapped.length);
      let out = 0;
      for (let i = 0; i < prodStates.length; i++) {
        const baseState = prodStates[i]!;
        const baseLog = prodLogW[i]!;
        for (let j = 0; j < mapped.length; j++) {
          nextStates[out] = baseState | mapped[j]!;
          nextLogW[out] = baseLog + comp.logW[j]!;
          out++;
        }
      }
      prodStates = nextStates;
      prodLogW = nextLogW;
    }

    const order = Array.from({ length: prodStates.length }, (_, i) => i);
    order.sort((a, b) => (prodStates[a]! < prodStates[b]! ? -1 : prodStates[a]! > prodStates[b]! ? 1 : 0));
    const states = order.map(i => prodStates[i]!);
    const logW = new Float64Array(order.length);
    const w = new Float64Array(order.length);
    for (let i = 0; i < order.length; i++) logW[i] = prodLogW[order[i]!]!;
    normalizeLogWeights(logW, w);

    const minTopo = this.graph.skillsById.get(mergedSkillIds[0]!)!.topoIndex;
    return {
      componentId: `comp-merged-${minTopo}`,
      skillIds: mergedSkillIds,
      localIndexBySkill,
      parentMasks,
      states,
      approximationMode: "exact",
      exactStateCountEstimate: states.length,
      logW,
      w,
    };
  }

  private componentSatisfactionProb(compIdx: number, reqMask: bigint): number {
    if (reqMask === 0n) return 1;
    const comp = this._components[compIdx]!;
    let sum = 0;
    for (let i = 0; i < comp.states.length; i++) if ((comp.states[i]! & reqMask) === reqMask) sum += comp.w[i]!;
    return clamp(sum, 0, 1);
  }

  computeProbeMutualInformation(probe: DiagnosticProbeItem): number {
    validateProbeItem(probe, this.graph.skillsById);
    const touched = this.touchedMasks(probe.requiredSkillIds);
    const touchedIndices = [...touched.keys()].sort((a, b) => a - b);
    const mergeCheck = this.checkCrossComponentMerge(touchedIndices);
    if (!mergeCheck.feasible) throw new DiagnosticPlacementError("INFEASIBLE", mergeCheck.reason);

    let pMastered = 1;
    for (const [cIdx, reqMask] of touched.entries()) {
      pMastered *= this.componentSatisfactionProb(cIdx, reqMask);
    }
    const p1 = 1 - probe.slip;
    const p0 = probe.guess;
    return Math.max(0, binaryEntropyBits(pMastered * p1 + (1 - pMastered) * p0) - (pMastered * binaryEntropyBits(p1) + (1 - pMastered) * binaryEntropyBits(p0)));
  }

  applyProbeObservation(probe: DiagnosticProbeItem, observation: DiagnosticProbeObservation): KstObservationUpdateResult {
    validateProbeItem(probe, this.graph.skillsById);
    if (!observation.observationId.trim()) throw new DiagnosticPlacementError("VALIDATION", "observationId must be non-empty");
    if (observation.itemId !== probe.itemId) throw new DiagnosticPlacementError("VALIDATION", `Observation itemId ${observation.itemId} does not match probe ${probe.itemId}`);

    const mkResult = (applied: boolean, reason: KstObservationUpdateResult["reason"]): KstObservationUpdateResult => ({
      applied, reason, observationId: observation.observationId, consumedProbeObservationIds: [...this.consumedProbeObservationIds],
    });
    if (this.seenObservationIds.has(observation.observationId)) return mkResult(false, "duplicate_observation");

    const touched = this.touchedMasks(probe.requiredSkillIds);
    const touchedIndices = [...touched.keys()].sort((a, b) => a - b);
    const mergeCheck = this.checkCrossComponentMerge(touchedIndices);
    if (!mergeCheck.feasible) throw new DiagnosticPlacementError("INFEASIBLE", mergeCheck.reason);

    if (!isUnassistedValidObservation(observation)) {
      this.seenObservationIds.add(observation.observationId);
      return mkResult(false, "assisted_or_invalid_response");
    }

    const likeMastered = observation.correct ? 1 - probe.slip : probe.slip;
    const likeUnmastered = observation.correct ? probe.guess : 1 - probe.guess;
    const logM = likeMastered > 0 ? Math.log(likeMastered) : -Infinity;
    const logU = likeUnmastered > 0 ? Math.log(likeUnmastered) : -Infinity;

    if (touchedIndices.length >= 2) {
      const merged = this.buildMergedComponentCandidate(touchedIndices);
      let reqMask = 0n;
      for (const skillId of probe.requiredSkillIds) reqMask |= 1n << BigInt(merged.localIndexBySkill.get(skillId)!);
      for (let i = 0; i < merged.states.length; i++) {
        merged.logW[i] = merged.logW[i]! + ((merged.states[i]! & reqMask) === reqMask ? logM : logU);
      }
      if (!normalizeLogWeights(merged.logW, merged.w)) {
        this.seenObservationIds.add(observation.observationId);
        return mkResult(false, "zero_likelihood_observation");
      }

      const touchedSet = new Set(touchedIndices);
      const nextComponents: ComponentSpace[] = [];
      for (let idx = 0; idx < this._components.length; idx++) {
        if (idx === touchedIndices[0]) nextComponents.push(merged);
        if (!touchedSet.has(idx)) nextComponents.push(this._components[idx]!);
      }
      this._components = nextComponents;
      this._componentIndexBySkill = new Map<string, number>();
      this._components.forEach((c, idx) => c.skillIds.forEach(id => this._componentIndexBySkill.set(id, idx)));
    } else {
      const cIdx = touchedIndices[0]!;
      const reqMask = touched.get(cIdx)!;
      const comp = this._components[cIdx]!;
      const savedLogW = comp.logW.slice();
      const savedW = comp.w.slice();
      for (let i = 0; i < comp.states.length; i++) {
        comp.logW[i] = comp.logW[i]! + ((comp.states[i]! & reqMask) === reqMask ? logM : logU);
      }
      if (!normalizeLogWeights(comp.logW, comp.w)) {
        comp.logW.set(savedLogW);
        comp.w.set(savedW);
        this.seenObservationIds.add(observation.observationId);
        return mkResult(false, "zero_likelihood_observation");
      }
    }

    this.seenObservationIds.add(observation.observationId);
    this.consumedProbeObservationIds.push(observation.observationId);
    return mkResult(true, "updated");
  }

  getSkillMarginals(): Record<string, number> {
    const marginals: Record<string, number> = {};
    for (const comp of this.components) {
      for (let k = 0; k < comp.skillIds.length; k++) {
        const bit = 1n << BigInt(k);
        let sum = 0;
        for (let s = 0; s < comp.states.length; s++) if ((comp.states[s]! & bit) !== 0n) sum += comp.w[s]!;
        marginals[comp.skillIds[k]!] = clamp(sum, 0, 1);
      }
    }
    return marginals;
  }

  getOuterFringeAndParentsSatisfied(): { outerFringeBySkill: Record<string, number>; parentsSatisfiedBySkill: Record<string, number> } {
    const outerFringeBySkill: Record<string, number> = {};
    const parentsSatisfiedBySkill: Record<string, number> = {};
    for (const comp of this.components) {
      for (let k = 0; k < comp.skillIds.length; k++) {
        const skillId = comp.skillIds[k]!;
        const bit = 1n << BigInt(k);
        const pMask = comp.parentMasks[k]!;
        let outerSum = 0;
        let parentsSum = 0;
        for (let s = 0; s < comp.states.length; s++) {
          const state = comp.states[s]!;
          if ((state & pMask) === pMask) {
            const weight = comp.w[s]!;
            parentsSum += weight;
            if ((state & bit) === 0n) outerSum += weight;
          }
        }
        outerFringeBySkill[skillId] = clamp(outerSum, 0, 1);
        parentsSatisfiedBySkill[skillId] = clamp(parentsSum, 0, 1);
      }
    }
    return { outerFringeBySkill, parentsSatisfiedBySkill };
  }

  getSkillCovariance(marginals = this.getSkillMarginals()): Record<string, Record<string, number>> {
    const covariance: Record<string, Record<string, number>> = {};
    const allSkills = this.graph.topoOrder;
    for (const id of allSkills) covariance[id] = {};
    for (const comp of this.components) {
      for (let i = 0; i < comp.skillIds.length; i++) {
        const u = comp.skillIds[i]!;
        const piU = marginals[u]!;
        covariance[u]![u] = clamp(piU * (1 - piU), 0, 0.25);
        for (let j = i + 1; j < comp.skillIds.length; j++) {
          const v = comp.skillIds[j]!;
          const both = (1n << BigInt(i)) | (1n << BigInt(j));
          let eUV = 0;
          for (let s = 0; s < comp.states.length; s++) if ((comp.states[s]! & both) === both) eUV += comp.w[s]!;
          const cov = Math.abs(eUV - piU * marginals[v]!) < EPSILON ? 0 : eUV - piU * marginals[v]!;
          covariance[u]![v] = cov;
          covariance[v]![u] = cov;
        }
      }
    }
    if (allSkills.length <= 100) {
      for (const u of allSkills) for (const v of allSkills) if (covariance[u]![v] === undefined) covariance[u]![v] = 0;
    }
    return covariance;
  }

  buildPriorSnapshot(options: { snapshotId?: string; courseId?: string; learnerId?: string; createdAtMs?: number } = {}): KstSnapshotV1 {
    const piBySkill = this.getSkillMarginals();
    const { outerFringeBySkill, parentsSatisfiedBySkill } = this.getOuterFringeAndParentsSatisfied();
    const skillCovariance = this.getSkillCovariance(piBySkill);
    const componentJointWeights: KstComponentJointWeights[] = this.components.map(comp => {
      const wByState: Record<string, number> = {};
      for (let s = 0; s < comp.states.length; s++) {
        const mastered = comp.skillIds.filter((_, k) => (comp.states[s]! & (1n << BigInt(k))) !== 0n);
        wByState[canonicalStateKey(mastered)] = comp.w[s]!;
      }
      return { componentId: comp.componentId, skillIds: [...comp.skillIds], approximationMode: comp.approximationMode, exactStateCountEstimate: comp.exactStateCountEstimate, stateCount: comp.states.length, wByState };
    });

    return {
      schemaVersion: 1,
      snapshotId: options.snapshotId ?? "kst-snapshot-v1",
      ...(options.courseId !== undefined ? { courseId: options.courseId } : {}),
      ...(options.learnerId !== undefined ? { learnerId: options.learnerId } : {}),
      createdAtMs: options.createdAtMs ?? 0,
      approximationMode: this.approximationMode,
      totalFeasibleStateCount: this.totalFeasibleStateCount,
      wByState: componentJointWeights.length === 1 ? componentJointWeights[0]!.wByState : null,
      componentJointWeights,
      piBySkill,
      outerFringeBySkill,
      parentsSatisfiedBySkill,
      skillCovariance,
      consumedProbeObservationIds: [...this.consumedProbeObservationIds],
    };
  }
}

export const createKstStateSpace = (skills: readonly DiagnosticSkillNode[]): KstStateSpace => new KstStateSpace(skills);

export const buildKstPriorSnapshot = (
  stateSpace: KstStateSpace,
  options: { snapshotId?: string; courseId?: string; learnerId?: string; createdAtMs?: number } = {},
): KstSnapshotV1 => stateSpace.buildPriorSnapshot(options);

export const getSkillCovariance = (snapshot: KstSnapshotV1, skillA: string, skillB: string): number =>
  snapshot.skillCovariance[skillA]?.[skillB] ?? 0;

export function partitionObservationsAgainstKstSnapshot<T extends {
  observationId: string;
  correct?: unknown;
  channel?: string;
  unassisted?: boolean;
  assisted?: boolean;
  hinted?: boolean;
  valid?: boolean;
  eligibleForFirePropagation?: boolean;
}>(
  snapshot: KstSnapshotV1,
  observations: readonly T[],
): PartitionedObservationsResult<T> {
  validateKstSnapshot(snapshot);
  const consumedSet = new Set(snapshot.consumedProbeObservationIds);
  const seenBatchIds = new Set<string>();
  const directObservations: T[] = [];
  const strippedConsumedObservations: PartitionedObservation<T>[] = [];
  const annotatedObservations: PartitionedObservation<T>[] = [];
  for (const obs of observations) {
    const id = typeof obs.observationId === "string" ? obs.observationId : "";
    const hasNonBlankId = id.trim().length > 0;
    const alreadyConsumed = hasNonBlankId && consumedSet.has(id);
    const duplicateInBatch = hasNonBlankId && !alreadyConsumed && seenBatchIds.has(id);
    const unassistedValid = "correct" in obs
      ? isUnassistedValidObservation(obs as { correct: unknown; channel?: string; unassisted?: boolean; assisted?: boolean; hinted?: boolean; valid?: boolean })
      : obs.valid !== false && obs.assisted !== true && obs.hinted !== true && obs.unassisted !== false
        && (obs.channel === undefined || obs.channel === "unassisted");
    const eligibleForDirectUpdate = hasNonBlankId && !alreadyConsumed && !duplicateInBatch && unassistedValid;
    const eligibleForFirePropagation = eligibleForDirectUpdate && (obs.eligibleForFirePropagation ?? true);

    if (eligibleForDirectUpdate) {
      seenBatchIds.add(id);
      directObservations.push(obs);
    }
    const annotated: PartitionedObservation<T> = {
      ...obs,
      alreadyConsumedByKst: alreadyConsumed,
      eligibleForDirectUpdate,
      eligibleForFirePropagation,
    };
    annotatedObservations.push(annotated);
    if (alreadyConsumed) strippedConsumedObservations.push(annotated);
  }
  return {
    directObservations,
    unconsumedObservations: directObservations,
    strippedConsumedObservations,
    annotatedObservations,
    consumedObservationIds: [...snapshot.consumedProbeObservationIds],
  };
}

export function buildSkillBeliefFromKstSnapshot(
  snapshot: KstSnapshotV1,
  skillId: string,
  meta: { workspaceId: string; learnerId: string; courseId: string; confirmedSkillVersion: string | number },
): SkillBeliefV1 {
  validateKstSnapshot(snapshot);
  const marginal = snapshot.piBySkill[skillId];
  if (marginal === undefined) throw new DiagnosticPlacementError("VALIDATION", `Skill ${skillId} missing from KstSnapshotV1`);
  const bounded = clamp(marginal, 1e-9, 1 - 1e-9);
  return createSkillBelief({ ...meta, abilityMean: Math.log(bounded / (1 - bounded)) });
}

export function updateSkillMasteryFromKstSnapshot(
  snapshot: KstSnapshotV1,
  skillId: string,
  observations: readonly DownstreamSkillProbeObservation[],
  beliefMeta?: { workspaceId: string; learnerId: string; courseId: string; confirmedSkillVersion: string | number },
): DownstreamSkillPosteriorResult {
  validateKstSnapshot(snapshot);
  const prior = snapshot.piBySkill[skillId];
  if (prior === undefined) throw new DiagnosticPlacementError("VALIDATION", `Skill ${skillId} missing from KstSnapshotV1`);
  const partitioned = partitionObservationsAgainstKstSnapshot(snapshot, observations);
  const appliedObservationIds: string[] = [];
  let posterior = clamp(prior, 0, 1);

  if (posterior > 0 && posterior < 1) {
    let logOdds = Math.log(posterior / (1 - posterior));
    for (const obs of partitioned.unconsumedObservations) {
      if (obs.skillId !== skillId || !isUnassistedValidObservation(obs)) continue;
      if (!Number.isFinite(obs.slip) || obs.slip < 0 || obs.slip >= 0.49
        || !Number.isFinite(obs.guess) || obs.guess < 0 || obs.guess >= 0.49 || !(1 - obs.slip > obs.guess)) {
        throw new DiagnosticPlacementError("VALIDATION", `Invalid slip/guess on observation ${obs.observationId}`);
      }
      const pM = obs.correct ? 1 - obs.slip : obs.slip;
      const pU = obs.correct ? obs.guess : 1 - obs.guess;
      appliedObservationIds.push(obs.observationId);
      if (pM === 0 && pU > 0) { posterior = 0; break; }
      if (pU === 0 && pM > 0) { posterior = 1; break; }
      if (pM > 0 && pU > 0) logOdds += Math.log(pM / pU);
    }
    if (posterior > 0 && posterior < 1) {
      posterior = logOdds >= 0 ? 1 / (1 + Math.exp(-logOdds)) : Math.exp(logOdds) / (1 + Math.exp(logOdds));
    }
  }

  const belief = beliefMeta
    ? createSkillBelief({ ...beliefMeta, abilityMean: Math.log(clamp(posterior, 1e-9, 1 - 1e-9) / (1 - clamp(posterior, 1e-9, 1 - 1e-9))) })
    : undefined;
  return { skillId, priorProbability: prior, posteriorProbability: posterior, appliedObservationIds, partitioned, ...(belief ? { belief } : {}) };
}
