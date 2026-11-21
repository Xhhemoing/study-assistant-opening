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

export function defineRecordEntry<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export function readRecordEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

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

export type KstComponentMetadata = {
  readonly componentId: string;
  readonly approximationMode: KstComponentMode;
  readonly stateCount: bigint;
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
  if (!Array.isArray(probe.requiredSkillIds) || probe.requiredSkillIds.length === 0) {
    throw new DiagnosticPlacementError("VALIDATION", `Probe ${probe.itemId} has empty requiredSkillIds`);
  }
  for (let i = 0; i < probe.requiredSkillIds.length; i++) {
    if (!Object.hasOwn(probe.requiredSkillIds, i) || typeof probe.requiredSkillIds[i] !== "string" || !knownSkillIds.has(probe.requiredSkillIds[i]!)) {
      throw new DiagnosticPlacementError("VALIDATION", `Probe ${probe.itemId} has empty or unknown requiredSkillIds`);
    }
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
    return Math.log(p) - Math.log1p(-p);
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

function validateProbabilityRecord(
  record: unknown,
  label: string,
  options: { min?: number; max?: number; requireSumOne?: boolean; requireNonEmpty?: boolean } = {},
): void {
  const min = options.min ?? 0;
  const max = options.max ?? 1;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new DiagnosticPlacementError("VALIDATION", `${label} must be a non-null record`);
  }
  const entries = Object.entries(record as Record<string, unknown>);
  if (options.requireNonEmpty && entries.length === 0) {
    throw new DiagnosticPlacementError("VALIDATION", `${label} must not be empty`);
  }
  let sum = 0;
  for (const [key, value] of entries) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new DiagnosticPlacementError("VALIDATION", `${label}[${key}] must be a finite number`);
    }
    if (value < min || value > max) {
      throw new DiagnosticPlacementError("VALIDATION", `${label}[${key}] must be within [${min}, ${max}]`);
    }
    sum += value;
  }
  if (options.requireSumOne && Math.abs(sum - 1) > 1e-5) {
    throw new DiagnosticPlacementError("VALIDATION", `${label} weights must sum to 1 (got ${sum})`);
  }
}

const SNAPSHOT_CONSISTENCY_EPSILON = 1e-9;

type ParsedStateEntry = {
  key: string;
  skills: readonly string[];
  weight: number;
};

export type CertifiedSnapshotProbabilities = {
  piBySkill: ReadonlyMap<string, number>;
  parentsSatisfiedBySkill: ReadonlyMap<string, number>;
  outerFringeBySkill: ReadonlyMap<string, number>;
};

function validateCanonicalStateRecord(
  record: unknown,
  label: string,
  allowedSkills: ReadonlySet<string>,
): ParsedStateEntry[] {
  validateProbabilityRecord(record, label, { requireSumOne: true, requireNonEmpty: true });
  const parsedStates: ParsedStateEntry[] = [];
  for (const [stateKey, rawWeight] of Object.entries(record as Record<string, number>)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stateKey);
    } catch {
      throw new DiagnosticPlacementError("VALIDATION", `${label} has invalid state key ${stateKey}`);
    }
    if (!Array.isArray(parsed)) {
      throw new DiagnosticPlacementError("VALIDATION", `${label} state key must be a JSON array`);
    }
    const items: string[] = [];
    for (let k = 0; k < parsed.length; k++) {
      if (!Object.hasOwn(parsed, k) || typeof parsed[k] !== "string") {
        throw new DiagnosticPlacementError("VALIDATION", `${label} state key ${stateKey} has invalid element at index ${k}`);
      }
      const skillId = parsed[k]!;
      if (!allowedSkills.has(skillId)) {
        throw new DiagnosticPlacementError("VALIDATION", `${label} references unknown state skill ${skillId}`);
      }
      if (k > 0 && !(cmpStr(parsed[k - 1]!, skillId) < 0)) {
        throw new DiagnosticPlacementError("VALIDATION", `${label} state key ${stateKey} must be strictly sorted and unique`);
      }
      items.push(skillId);
    }
    if (JSON.stringify(items) !== stateKey) {
      throw new DiagnosticPlacementError("VALIDATION", `${label} has non-canonical state key ${stateKey}`);
    }
    parsedStates.push({ key: stateKey, skills: items, weight: rawWeight });
  }
  return parsedStates;
}

function validateSnapshotAgainstDag(
  snapshot: KstSnapshotV1,
  knownSkills: ReadonlySet<string>,
  prereqsMap: ReadonlyMap<string, readonly string[]>,
  graph: ValidatedSkillGraph,
  compSkillSets: readonly ReadonlySet<string>[],
  compParsedEntries: readonly (readonly ParsedStateEntry[])[],
  snapshotParsedEntries: readonly ParsedStateEntry[] | null,
): { parentsSatisfiedBySkill: Map<string, number>; outerFringeBySkill: Map<string, number> } {
  if (knownSkills.size !== graph.topoOrder.length || !graph.topoOrder.every(id => knownSkills.has(id))) {
    throw new DiagnosticPlacementError("VALIDATION", "Snapshot skills do not match prerequisite DAG");
  }
  // No prerequisite edge may cross between different componentJointWeights entries
  const compIndexBySkill = new Map<string, number>();
  compSkillSets.forEach((set, idx) => set.forEach(s => compIndexBySkill.set(s, idx)));
  if (compSkillSets.length > 0) {
    for (const [u, parents] of prereqsMap.entries()) {
      const cu = compIndexBySkill.get(u);
      for (const p of parents) {
        if (compIndexBySkill.get(p) !== cu) {
          throw new DiagnosticPlacementError("VALIDATION", `Prerequisite edge ${p} -> ${u} crosses KST snapshot components`);
        }
      }
    }
  }
  // Every state key in wByState and comp.wByState must be downward-closed
  const checkDownset = (entries: readonly ParsedStateEntry[], label: string): void => {
    for (const entry of entries) {
      const stateSet = new Set(entry.skills);
      for (const u of entry.skills) {
        for (const p of prereqsMap.get(u) ?? []) {
          if (!stateSet.has(p)) {
            throw new DiagnosticPlacementError("VALIDATION", `${label} contains non-downward-closed state missing prerequisite ${p} of ${u}`);
          }
        }
      }
    }
  };
  if (snapshotParsedEntries) checkDownset(snapshotParsedEntries, "wByState");
  for (let idx = 0; idx < compParsedEntries.length; idx++) {
    checkDownset(compParsedEntries[idx]!, `componentJointWeights[${idx}].wByState`);
  }

  // Build sub-DAG component mapping so exact downset enumeration runs per weakly-connected DAG subcomponent (fast O(sum))
  const subCompBySkill = new Map<string, number>();
  graph.components.forEach((sub, sIdx) => sub.forEach(id => subCompBySkill.set(id, sIdx)));
  const subCompExactCounts: Array<bigint | "exceeded"> = graph.components.map(subSkills => {
    const res = enumerateDownsetsBounded(subSkills, graph, MAX_EXACT_KST_STATES);
    return res.exceededLimit ? "exceeded" : BigInt(res.states.length);
  });
  const anySubExceeded = subCompExactCounts.some(c => c === "exceeded");
  let trueTotalStates: bigint | "exceeded" = "exceeded";
  if (!anySubExceeded) {
    let prod = 1n;
    for (const c of subCompExactCounts) prod *= c as bigint;
    trueTotalStates = prod;
  }

  const maxExactBig = BigInt(MAX_EXACT_KST_STATES);
  const expectedTopMode: KstApproximationMode = anySubExceeded
    ? "bounded_component_envelope"
    : (trueTotalStates as bigint) <= maxExactBig
      ? "exact"
      : "component_decomposed";
  if (snapshot.approximationMode !== expectedTopMode) {
    throw new DiagnosticPlacementError(
      "VALIDATION",
      `Snapshot approximationMode ${snapshot.approximationMode} does not match true DAG mode ${expectedTopMode}`,
    );
  }

  for (let idx = 0; idx < snapshot.componentJointWeights.length; idx++) {
    const comp = snapshot.componentJointWeights[idx]!;
    const subIndices = new Set<number>();
    for (const s of comp.skillIds) subIndices.add(subCompBySkill.get(s)!);
    let hasExceededSub = false;
    let trueCount = 1n;
    for (const sIdx of subIndices) {
      const subCount = subCompExactCounts[sIdx]!;
      if (subCount === "exceeded") {
        hasExceededSub = true;
        break;
      }
      trueCount *= subCount;
    }

    if (hasExceededSub) {
      if (subIndices.size !== 1) {
        throw new DiagnosticPlacementError(
          "VALIDATION",
          `componentJointWeights[${idx}] cannot merge a bounded component with other DAG components`,
        );
      }
      if (comp.approximationMode !== "bounded_component_envelope") {
        throw new DiagnosticPlacementError(
          "VALIDATION",
          `componentJointWeights[${idx}] exceeds MAX_EXACT_KST_STATES under true prerequisite DAG`,
        );
      }
      if (comp.stateCount > MAX_EXACT_KST_STATES || comp.exactStateCountEstimate !== null) {
        throw new DiagnosticPlacementError(
          "VALIDATION",
          `componentJointWeights[${idx}] has invalid bounded component metadata`,
        );
      }
    } else if (trueCount <= maxExactBig) {
      if (comp.approximationMode !== "exact") {
        throw new DiagnosticPlacementError(
          "VALIDATION",
          `componentJointWeights[${idx}] has <= ${MAX_EXACT_KST_STATES} feasible DAG states (${trueCount}) and must use exact mode`,
        );
      }
      if (BigInt(comp.stateCount) !== trueCount || BigInt(comp.exactStateCountEstimate ?? -1) !== trueCount) {
        throw new DiagnosticPlacementError(
          "VALIDATION",
          `componentJointWeights[${idx}] stateCount does not match true DAG downset count (${trueCount})`,
        );
      }
    } else {
      throw new DiagnosticPlacementError(
        "VALIDATION",
        `componentJointWeights[${idx}] merges exact DAG components beyond MAX_EXACT_KST_STATES (${trueCount})`,
      );
    }
  }

  // Encode component states as BigInt masks once so exact joint parent/fringe sums run in O(sum states)
  const compEncodings = snapshot.componentJointWeights.map((comp, idx) => {
    const localIdx = new Map<string, number>();
    comp.skillIds.forEach((id, k) => localIdx.set(id, k));
    const entries = compParsedEntries[idx]!;
    const rawPi = new Map<string, number>();
    let totalWeight = 0;
    const encodedStates = entries.map(entry => {
      let mask = 0n;
      totalWeight += entry.weight;
      for (const s of entry.skills) {
        mask |= 1n << BigInt(localIdx.get(s)!);
        rawPi.set(s, (rawPi.get(s) ?? 0) + entry.weight);
      }
      return { mask, weight: entry.weight };
    });
    return { localIdx, encodedStates, totalWeight, rawPi };
  });

  const derivedParentsSatisfiedBySkill = new Map<string, number>();
  const derivedOuterFringeBySkill = new Map<string, number>();
  for (const skillId of knownSkills) {
    const compIdx = compIndexBySkill.get(skillId)!;
    const enc = compEncodings[compIdx]!;
    const skillBit = 1n << BigInt(enc.localIdx.get(skillId)!);
    const parents = prereqsMap.get(skillId) ?? [];
    const parentsByComp = new Map<number, string[]>();
    for (const p of parents) {
      const pCompIdx = compIndexBySkill.get(p)!;
      let list = parentsByComp.get(pCompIdx);
      if (!list) {
        list = [];
        parentsByComp.set(pCompIdx, list);
      }
      list.push(p);
    }

    let otherCompParentsProb = 1;
    for (const [pCompIdx, pList] of parentsByComp.entries()) {
      if (pCompIdx === compIdx) continue;
      const pEnc = compEncodings[pCompIdx]!;
      let pMask = 0n;
      for (const p of pList) pMask |= 1n << BigInt(pEnc.localIdx.get(p)!);
      let sum = 0;
      for (const st of pEnc.encodedStates) {
        if ((st.mask & pMask) === pMask) sum += st.weight;
      }
      otherCompParentsProb *= clamp(sum, 0, 1);
    }

    const sameCompParents = parentsByComp.get(compIdx) ?? [];
    let sameCompParentsProb = 0;
    let sameCompOuterProb = 0;
    if (sameCompParents.length === 0) {
      sameCompParentsProb = enc.totalWeight;
      sameCompOuterProb = enc.totalWeight - (enc.rawPi.get(skillId) ?? 0);
    } else {
      let pMask = 0n;
      for (const p of sameCompParents) pMask |= 1n << BigInt(enc.localIdx.get(p)!);
      for (const st of enc.encodedStates) {
        if ((st.mask & pMask) === pMask) {
          sameCompParentsProb += st.weight;
          if ((st.mask & skillBit) === 0n) sameCompOuterProb += st.weight;
        }
      }
    }

    const derivedParentsSat = clamp(sameCompParentsProb * otherCompParentsProb, 0, 1);
    const derivedOuter = clamp(sameCompOuterProb * otherCompParentsProb, 0, 1);
    const reportedParentsSat = readRecordEntry(snapshot.parentsSatisfiedBySkill, skillId)!;
    const reportedOuter = readRecordEntry(snapshot.outerFringeBySkill, skillId)!;
    if (Math.abs(reportedParentsSat - derivedParentsSat) > SNAPSHOT_CONSISTENCY_EPSILON) {
      throw new DiagnosticPlacementError(
        "VALIDATION",
        `parentsSatisfiedBySkill[${skillId}] (${reportedParentsSat}) disagrees with componentJointWeights (${derivedParentsSat})`,
      );
    }
    if (Math.abs(reportedOuter - derivedOuter) > SNAPSHOT_CONSISTENCY_EPSILON) {
      throw new DiagnosticPlacementError(
        "VALIDATION",
        `outerFringeBySkill[${skillId}] (${reportedOuter}) disagrees with componentJointWeights (${derivedOuter})`,
      );
    }
    derivedParentsSatisfiedBySkill.set(skillId, derivedParentsSat);
    derivedOuterFringeBySkill.set(skillId, derivedOuter);
  }

  return {
    parentsSatisfiedBySkill: derivedParentsSatisfiedBySkill,
    outerFringeBySkill: derivedOuterFringeBySkill,
  };
}

export function certifyKstSnapshot(snapshot: KstSnapshotV1, skills?: readonly DiagnosticSkillNode[]): CertifiedSnapshotProbabilities {
  if (!snapshot || typeof snapshot !== "object" || snapshot.schemaVersion !== 1 || typeof snapshot.snapshotId !== "string" || !snapshot.snapshotId.trim()) {
    throw new DiagnosticPlacementError("VALIDATION", "Invalid KstSnapshotV1 header");
  }
  if (
    snapshot.approximationMode !== "exact" &&
    snapshot.approximationMode !== "component_decomposed" &&
    snapshot.approximationMode !== "bounded_component_envelope"
  ) {
    throw new DiagnosticPlacementError("VALIDATION", "Invalid KstSnapshotV1 approximationMode");
  }
  if (!Number.isFinite(snapshot.createdAtMs)) {
    throw new DiagnosticPlacementError("VALIDATION", "KstSnapshotV1 createdAtMs must be finite");
  }
  if (
    snapshot.totalFeasibleStateCount !== null &&
    (typeof snapshot.totalFeasibleStateCount !== "number" || !Number.isSafeInteger(snapshot.totalFeasibleStateCount) || snapshot.totalFeasibleStateCount < 0)
  ) {
    throw new DiagnosticPlacementError("VALIDATION", "KstSnapshotV1 totalFeasibleStateCount must be null or a non-negative safe integer");
  }
  if (
    snapshot.totalFeasibleStateCountExact !== undefined &&
    snapshot.totalFeasibleStateCountExact !== null &&
    (typeof snapshot.totalFeasibleStateCountExact !== "string" || !/^\d+$/.test(snapshot.totalFeasibleStateCountExact))
  ) {
    throw new DiagnosticPlacementError("VALIDATION", "KstSnapshotV1 totalFeasibleStateCountExact must be null or a non-negative integer string");
  }
  validateProbabilityRecord(snapshot.piBySkill, "piBySkill", { requireNonEmpty: true });
  validateProbabilityRecord(snapshot.outerFringeBySkill, "outerFringeBySkill", { requireNonEmpty: true });
  validateProbabilityRecord(snapshot.parentsSatisfiedBySkill, "parentsSatisfiedBySkill", { requireNonEmpty: true });
  const knownSkills = new Set(Object.keys(snapshot.piBySkill));
  const parentsSatKeys = Object.keys(snapshot.parentsSatisfiedBySkill);
  for (const skillId of parentsSatKeys) {
    if (!knownSkills.has(skillId)) {
      throw new DiagnosticPlacementError("VALIDATION", `parentsSatisfiedBySkill references unknown skill ${skillId}`);
    }
  }
  if (parentsSatKeys.length !== knownSkills.size) {
    throw new DiagnosticPlacementError("VALIDATION", "parentsSatisfiedBySkill must cover every skill in piBySkill");
  }
  const outerKeys = Object.keys(snapshot.outerFringeBySkill);
  for (const [skillId, outer] of Object.entries(snapshot.outerFringeBySkill)) {
    if (!knownSkills.has(skillId)) {
      throw new DiagnosticPlacementError("VALIDATION", `outerFringeBySkill references unknown skill ${skillId}`);
    }
    const parentsSat = readRecordEntry(snapshot.parentsSatisfiedBySkill, skillId);
    if (parentsSat !== undefined && outer > parentsSat + 1e-6) {
      throw new DiagnosticPlacementError("VALIDATION", `outerFringeBySkill[${skillId}] exceeds parentsSatisfiedBySkill[${skillId}]`);
    }
    const pi = readRecordEntry(snapshot.piBySkill, skillId);
    if (pi !== undefined && outer + pi > 1 + 1e-6) {
      throw new DiagnosticPlacementError("VALIDATION", `outerFringeBySkill[${skillId}] + piBySkill[${skillId}] exceeds 1`);
    }
  }
  if (outerKeys.length !== knownSkills.size) {
    throw new DiagnosticPlacementError("VALIDATION", "outerFringeBySkill must cover every skill in piBySkill");
  }
  const snapshotParsedEntries = snapshot.wByState !== null
    ? validateCanonicalStateRecord(snapshot.wByState, "wByState", knownSkills)
    : null;
  if (!Array.isArray(snapshot.componentJointWeights)) {
    throw new DiagnosticPlacementError("VALIDATION", "KstSnapshotV1 componentJointWeights must be an array");
  }
  const seenCompSkills = new Set<string>();
  const compSkillSets: Set<string>[] = [];
  const compParsedEntries: ParsedStateEntry[][] = [];
  const compWeightMaps: Map<string, number>[] = [];
  const compIndexBySkill = new Map<string, number>();
  let allComponentsExact = true;
  let hasBoundedComponent = false;
  let exactStateProduct = 1n;
  for (let idx = 0; idx < snapshot.componentJointWeights.length; idx++) {
    if (!Object.hasOwn(snapshot.componentJointWeights, idx)) {
      throw new DiagnosticPlacementError("VALIDATION", `componentJointWeights[${idx}] must not be a sparse hole`);
    }
    const comp = snapshot.componentJointWeights[idx]!;
    if (!comp || typeof comp !== "object") {
      throw new DiagnosticPlacementError("VALIDATION", `componentJointWeights[${idx}] must be an object`);
    }
    if (comp.approximationMode !== "exact" && comp.approximationMode !== "bounded_component_envelope") {
      throw new DiagnosticPlacementError("VALIDATION", `componentJointWeights[${idx}] has invalid approximationMode`);
    }
    if (!Array.isArray(comp.skillIds) || comp.skillIds.length === 0) {
      throw new DiagnosticPlacementError("VALIDATION", `componentJointWeights[${idx}].skillIds must be a non-empty array`);
    }
    const compSkillSet = new Set<string>();
    for (let sIdx = 0; sIdx < comp.skillIds.length; sIdx++) {
      if (!Object.hasOwn(comp.skillIds, sIdx) || typeof comp.skillIds[sIdx] !== "string" || !comp.skillIds[sIdx]!.trim()) {
        throw new DiagnosticPlacementError("VALIDATION", `componentJointWeights[${idx}].skillIds[${sIdx}] must be a non-empty string`);
      }
      const skillId = comp.skillIds[sIdx]!;
      if (!knownSkills.has(skillId)) {
        throw new DiagnosticPlacementError("VALIDATION", `componentJointWeights[${idx}] references unknown skill ${skillId}`);
      }
      if (seenCompSkills.has(skillId)) {
        throw new DiagnosticPlacementError("VALIDATION", `Duplicate skill ${skillId} in componentJointWeights`);
      }
      seenCompSkills.add(skillId);
      compSkillSet.add(skillId);
      compIndexBySkill.set(skillId, idx);
    }
    compSkillSets.push(compSkillSet);
    const parsedComp = validateCanonicalStateRecord(comp.wByState, `componentJointWeights[${idx}].wByState`, compSkillSet);
    compParsedEntries.push(parsedComp);
    const compMap = new Map<string, number>();
    for (const entry of parsedComp) compMap.set(entry.key, entry.weight);
    compWeightMaps.push(compMap);
    if (!Number.isSafeInteger(comp.stateCount) || comp.stateCount !== parsedComp.length) {
      throw new DiagnosticPlacementError("VALIDATION", `componentJointWeights[${idx}].stateCount mismatch`);
    }
    if (comp.approximationMode === "exact") {
      if (comp.stateCount > MAX_EXACT_KST_STATES || comp.exactStateCountEstimate !== comp.stateCount) {
        throw new DiagnosticPlacementError("VALIDATION", `componentJointWeights[${idx}] invalid exact component metadata`);
      }
      exactStateProduct *= BigInt(comp.stateCount);
    } else {
      allComponentsExact = false;
      hasBoundedComponent = true;
      if (comp.exactStateCountEstimate !== null) {
        throw new DiagnosticPlacementError("VALIDATION", `componentJointWeights[${idx}] bounded component must have null exactStateCountEstimate`);
      }
    }
  }
  if (knownSkills.size > 0 && snapshot.componentJointWeights.length === 0) {
    throw new DiagnosticPlacementError("VALIDATION", "componentJointWeights must not be empty for non-empty snapshot skills");
  }
  if (snapshot.componentJointWeights.length > 0 && seenCompSkills.size !== knownSkills.size) {
    throw new DiagnosticPlacementError("VALIDATION", "componentJointWeights must partition snapshot skills");
  }
  if (snapshot.componentJointWeights.length > 0) {
    if (snapshot.approximationMode === "bounded_component_envelope") {
      if (!hasBoundedComponent || snapshot.totalFeasibleStateCount !== null || snapshot.totalFeasibleStateCountExact !== null) {
        throw new DiagnosticPlacementError("VALIDATION", "bounded_component_envelope snapshot requires bounded component and null exact counts");
      }
    } else {
      if (!allComponentsExact || hasBoundedComponent) {
        throw new DiagnosticPlacementError("VALIDATION", `Snapshot approximationMode ${snapshot.approximationMode} conflicts with bounded component`);
      }
      if (snapshot.approximationMode === "exact" && (snapshot.componentJointWeights.length !== 1 || exactStateProduct > BigInt(MAX_EXACT_KST_STATES))) {
        throw new DiagnosticPlacementError("VALIDATION", "Snapshot exact mode requires a single component within MAX_EXACT_KST_STATES");
      }
      if (snapshot.approximationMode === "component_decomposed" && (snapshot.componentJointWeights.length < 2 || exactStateProduct <= BigInt(MAX_EXACT_KST_STATES))) {
        throw new DiagnosticPlacementError("VALIDATION", "Snapshot component_decomposed mode requires >= 2 components and product > MAX_EXACT_KST_STATES");
      }
      if (typeof snapshot.totalFeasibleStateCountExact !== "string" || snapshot.totalFeasibleStateCountExact !== exactStateProduct.toString()) {
        throw new DiagnosticPlacementError("VALIDATION", "Non-bounded snapshot requires exact totalFeasibleStateCountExact string matching component state product");
      }
      const expectedSafeCount = exactStateProduct <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exactStateProduct) : null;
      if (snapshot.totalFeasibleStateCount !== expectedSafeCount) {
        throw new DiagnosticPlacementError("VALIDATION", "Snapshot totalFeasibleStateCount does not match component state product");
      }
    }
  }

  // Verify global wByState matches independent componentJointWeights product and has exact bijection count
  if (snapshotParsedEntries !== null) {
    if (
      snapshot.approximationMode !== "exact" ||
      snapshot.totalFeasibleStateCount === null ||
      snapshot.totalFeasibleStateCount > MAX_EXACT_KST_STATES
    ) {
      throw new DiagnosticPlacementError(
        "VALIDATION",
        "wByState must be null unless approximationMode is exact within MAX_EXACT_KST_STATES",
      );
    }
    if (snapshot.componentJointWeights.length > 0 && BigInt(snapshotParsedEntries.length) !== exactStateProduct) {
      throw new DiagnosticPlacementError(
        "VALIDATION",
        `wByState state count (${snapshotParsedEntries.length}) must equal exact state product (${exactStateProduct})`,
      );
    }
    const globalWeightMap = new Map<string, number>();
    const numComps = snapshot.componentJointWeights.length;
    for (const entry of snapshotParsedEntries) {
      globalWeightMap.set(entry.key, entry.weight);
      const buckets: string[][] = Array.from({ length: numComps }, () => []);
      for (const skillId of entry.skills) buckets[compIndexBySkill.get(skillId)!]!.push(skillId);
      let expectedProduct = 1;
      for (let idx = 0; idx < numComps; idx++) {
        expectedProduct *= compWeightMaps[idx]!.get(JSON.stringify(buckets[idx]!)) ?? 0;
      }
      if (Math.abs(entry.weight - expectedProduct) > SNAPSHOT_CONSISTENCY_EPSILON) {
        throw new DiagnosticPlacementError(
          "VALIDATION",
          `wByState[${entry.key}] (${entry.weight}) disagrees with componentJointWeights product (${expectedProduct})`,
        );
      }
    }
    if (numComps === 1) {
      for (const [compKey, compWeight] of compWeightMaps[0]!.entries()) {
        const globalW = globalWeightMap.get(compKey) ?? 0;
        if (Math.abs(compWeight - globalW) > SNAPSHOT_CONSISTENCY_EPSILON) {
          throw new DiagnosticPlacementError(
            "VALIDATION",
            `componentJointWeights[0].wByState[${compKey}] (${compWeight}) disagrees with wByState (${globalW})`,
          );
        }
      }
    }
  }

  // Always recompute piBySkill marginals directly from componentJointWeights
  const derivedPiBySkill = new Map<string, number>();
  for (let idx = 0; idx < compParsedEntries.length; idx++) {
    const rawPi = new Map<string, number>();
    for (const entry of compParsedEntries[idx]!) {
      for (const skillId of entry.skills) rawPi.set(skillId, (rawPi.get(skillId) ?? 0) + entry.weight);
    }
    for (const skillId of snapshot.componentJointWeights[idx]!.skillIds) {
      const pi = clamp(rawPi.get(skillId) ?? 0, 0, 1);
      const reportedPi = readRecordEntry(snapshot.piBySkill, skillId)!;
      if (Math.abs(reportedPi - pi) > SNAPSHOT_CONSISTENCY_EPSILON) {
        throw new DiagnosticPlacementError(
          "VALIDATION",
          `piBySkill[${skillId}] (${reportedPi}) disagrees with componentJointWeights marginal (${pi})`,
        );
      }
      derivedPiBySkill.set(skillId, pi);
    }
  }

  if (!snapshot.skillCovariance || typeof snapshot.skillCovariance !== "object" || Array.isArray(snapshot.skillCovariance)) {
    throw new DiagnosticPlacementError("VALIDATION", "KstSnapshotV1 skillCovariance must be a record");
  }
  for (const [skillId, row] of Object.entries(snapshot.skillCovariance)) {
    validateProbabilityRecord(row, `skillCovariance[${skillId}]`, { min: -0.25 - 1e-6, max: 0.25 + 1e-6 });
  }
  if (!Array.isArray(snapshot.consumedProbeObservationIds)) {
    throw new DiagnosticPlacementError("VALIDATION", "KstSnapshotV1 consumedProbeObservationIds must be string[]");
  }
  for (let idx = 0; idx < snapshot.consumedProbeObservationIds.length; idx++) {
    if (!Object.hasOwn(snapshot.consumedProbeObservationIds, idx) || typeof snapshot.consumedProbeObservationIds[idx] !== "string") {
      throw new DiagnosticPlacementError("VALIDATION", `KstSnapshotV1 consumedProbeObservationIds[${idx}] must be a string`);
    }
  }

  if (!snapshot.prerequisitesBySkill || typeof snapshot.prerequisitesBySkill !== "object" || Array.isArray(snapshot.prerequisitesBySkill)) {
    throw new DiagnosticPlacementError("VALIDATION", "KstSnapshotV1 prerequisitesBySkill is required and must be a record");
  }
  const syntheticNodes: DiagnosticSkillNode[] = [];
  for (const [skillId, rawParents] of Object.entries(snapshot.prerequisitesBySkill)) {
    if (!knownSkills.has(skillId) || !Array.isArray(rawParents)) {
      throw new DiagnosticPlacementError("VALIDATION", `Invalid prerequisitesBySkill entry for ${skillId}`);
    }
    for (let k = 0; k < rawParents.length; k++) {
      if (!Object.hasOwn(rawParents, k) || typeof rawParents[k] !== "string" || !knownSkills.has(rawParents[k]!)) {
        throw new DiagnosticPlacementError("VALIDATION", `Invalid prerequisite reference in prerequisitesBySkill[${skillId}]`);
      }
    }
    syntheticNodes.push({ skillId, chapterId: "snapshot", prerequisiteIds: rawParents });
  }
  if (syntheticNodes.length !== knownSkills.size) {
    throw new DiagnosticPlacementError("VALIDATION", "prerequisitesBySkill must cover every skill in piBySkill");
  }
  const snapshotGraph = validateSkillGraph(syntheticNodes);
  const snapshotPrereqs = new Map<string, readonly string[]>();
  for (const [id, rec] of snapshotGraph.skillsById.entries()) snapshotPrereqs.set(id, rec.prerequisiteIds);

  let skillsPrereqs: Map<string, readonly string[]> | null = null;
  let skillsGraph: ValidatedSkillGraph | null = null;
  if (skills !== undefined) {
    skillsGraph = validateSkillGraph(skills);
    skillsPrereqs = new Map<string, readonly string[]>();
    for (const [id, rec] of skillsGraph.skillsById.entries()) skillsPrereqs.set(id, rec.prerequisiteIds);

    if (snapshotPrereqs.size !== skillsPrereqs.size) {
      throw new DiagnosticPlacementError("VALIDATION", "Snapshot prerequisitesBySkill skill set disagrees with skills");
    }
    for (const [skillId, snapParents] of snapshotPrereqs.entries()) {
      const givenParents = skillsPrereqs.get(skillId);
      if (
        !givenParents ||
        givenParents.length !== snapParents.length ||
        snapParents.some((p, i) => p !== givenParents[i])
      ) {
        throw new DiagnosticPlacementError("VALIDATION", `Snapshot prerequisitesBySkill disagrees with skills DAG for ${skillId}`);
      }
    }
  }

  const validatedGraph = skillsGraph ?? snapshotGraph;
  const validatedPrereqs = skillsPrereqs ?? snapshotPrereqs;
  const { parentsSatisfiedBySkill, outerFringeBySkill } = validateSnapshotAgainstDag(
    snapshot,
    knownSkills,
    validatedPrereqs,
    validatedGraph,
    compSkillSets,
    compParsedEntries,
    snapshotParsedEntries,
  );
  return { piBySkill: derivedPiBySkill, parentsSatisfiedBySkill, outerFringeBySkill };
}

export function validateKstSnapshot(snapshot: KstSnapshotV1, skills?: readonly DiagnosticSkillNode[]): void {
  certifyKstSnapshot(snapshot, skills);
}

export class KstStateSpace {
  readonly graph: ValidatedSkillGraph;
  readonly approximationMode: KstApproximationMode;
  readonly totalFeasibleStateCount: number | null;
  readonly totalFeasibleStateCountExact: string | null;
  readonly #consumedProbeObservationIds: string[] = [];
  readonly #seenObservationIds = new Set<string>();
  private _components: ComponentSpace[];
  private _componentIndexBySkill: Map<string, number>;

  get consumedProbeObservationIds(): readonly string[] {
    return Object.freeze([...this.#consumedProbeObservationIds]);
  }

  get components(): readonly ComponentSpace[] {
    return this._components;
  }

  get componentIndexBySkill(): ReadonlyMap<string, number> {
    return this._componentIndexBySkill;
  }

  getComponentMetadata(): readonly KstComponentMetadata[] {
    return this._components.map(c => ({
      componentId: c.componentId,
      approximationMode: c.approximationMode,
      stateCount: BigInt(c.states.length),
    }));
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
    this.totalFeasibleStateCountExact = anyExceeded ? null : exactProduct.toString();

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
    if (!Array.isArray(probe.requiredSkillIds) || probe.requiredSkillIds.length === 0) return false;
    for (let i = 0; i < probe.requiredSkillIds.length; i++) {
      if (!Object.hasOwn(probe.requiredSkillIds, i) || typeof probe.requiredSkillIds[i] !== "string" || !this.graph.skillsById.has(probe.requiredSkillIds[i]!)) {
        return false;
      }
    }
    const touchedIndices = [...this.touchedMasks(probe.requiredSkillIds).keys()].sort((a, b) => a - b);
    return this.checkCrossComponentMerge(touchedIndices).feasible;
  }

  canEvaluateProbeAfter(priorCandidate: DiagnosticProbeItem, nextProbe: DiagnosticProbeItem): boolean {
    const validSkills = (item: DiagnosticProbeItem): boolean => {
      if (!Array.isArray(item.requiredSkillIds) || item.requiredSkillIds.length === 0) return false;
      for (let i = 0; i < item.requiredSkillIds.length; i++) {
        if (!Object.hasOwn(item.requiredSkillIds, i) || typeof item.requiredSkillIds[i] !== "string" || !this.graph.skillsById.has(item.requiredSkillIds[i]!)) {
          return false;
        }
      }
      return true;
    };
    if (!validSkills(priorCandidate) || !validSkills(nextProbe)) {
      return false;
    }
    const priorTouchedIndices = [...this.touchedMasks(priorCandidate.requiredSkillIds).keys()].sort((a, b) => a - b);
    const priorMerge = this.checkCrossComponentMerge(priorTouchedIndices);
    if (!priorMerge.feasible) return false;

    if (priorTouchedIndices.length <= 1) {
      return this.canEvaluateProbe(nextProbe);
    }

    const priorTouchedSet = new Set(priorTouchedIndices);
    const mergedGroupId = priorTouchedIndices[0]!;
    const groupStateCount = (groupId: number): number =>
      groupId === mergedGroupId ? priorMerge.productCount : this._components[groupId]!.states.length;
    const groupApproxMode = (groupId: number): KstComponentMode =>
      groupId === mergedGroupId ? "exact" : this._components[groupId]!.approximationMode;

    const nextGroups = new Set<number>();
    for (const skillId of nextProbe.requiredSkillIds) {
      const origCompIdx = this._componentIndexBySkill.get(skillId)!;
      nextGroups.add(priorTouchedSet.has(origCompIdx) ? mergedGroupId : origCompIdx);
    }
    if (nextGroups.size <= 1) return true;

    let product = 1n;
    for (const gId of nextGroups) {
      if (groupApproxMode(gId) !== "exact") return false;
      product *= BigInt(groupStateCount(gId));
      if (product > BigInt(MAX_EXACT_KST_STATES)) return false;
    }
    return true;
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
    const canonicalObsId = observation.observationId.trim();
    if (!canonicalObsId) throw new DiagnosticPlacementError("VALIDATION", "observationId must be non-empty");
    if (observation.itemId !== probe.itemId) throw new DiagnosticPlacementError("VALIDATION", `Observation itemId ${observation.itemId} does not match probe ${probe.itemId}`);

    const mkResult = (applied: boolean, reason: KstObservationUpdateResult["reason"]): KstObservationUpdateResult => ({
      applied, reason, observationId: canonicalObsId, consumedProbeObservationIds: this.consumedProbeObservationIds,
    });
    if (this.#seenObservationIds.has(canonicalObsId)) return mkResult(false, "duplicate_observation");

    const touched = this.touchedMasks(probe.requiredSkillIds);
    const touchedIndices = [...touched.keys()].sort((a, b) => a - b);
    const mergeCheck = this.checkCrossComponentMerge(touchedIndices);
    if (!mergeCheck.feasible) throw new DiagnosticPlacementError("INFEASIBLE", mergeCheck.reason);

    if (!isUnassistedValidObservation(observation)) {
      this.#seenObservationIds.add(canonicalObsId);
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
        this.#seenObservationIds.add(canonicalObsId);
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
        this.#seenObservationIds.add(canonicalObsId);
        return mkResult(false, "zero_likelihood_observation");
      }
    }

    this.#seenObservationIds.add(canonicalObsId);
    this.#consumedProbeObservationIds.push(canonicalObsId);
    return mkResult(true, "updated");
  }

  willMergeComponentsForObservation(probe: DiagnosticProbeItem, observation: DiagnosticProbeObservation): boolean {
    if (
      !probe ||
      typeof probe.itemId !== "string" ||
      !probe.itemId.trim() ||
      !Number.isFinite(probe.slip) ||
      probe.slip < 0 ||
      probe.slip >= 0.49 ||
      !Number.isFinite(probe.guess) ||
      probe.guess < 0 ||
      probe.guess >= 0.49 ||
      !(1 - probe.slip > probe.guess) ||
      !Array.isArray(probe.requiredSkillIds) ||
      probe.requiredSkillIds.length === 0
    ) {
      return false;
    }
    for (let i = 0; i < probe.requiredSkillIds.length; i++) {
      if (
        !Object.hasOwn(probe.requiredSkillIds, i) ||
        typeof probe.requiredSkillIds[i] !== "string" ||
        !this.graph.skillsById.has(probe.requiredSkillIds[i]!)
      ) {
        return false;
      }
    }
    const canonicalObsId = typeof observation.observationId === "string" ? observation.observationId.trim() : "";
    if (!canonicalObsId || observation.itemId !== probe.itemId) return false;
    if (this.#seenObservationIds.has(canonicalObsId)) return false;
    if (!isUnassistedValidObservation(observation)) return false;

    const touched = this.touchedMasks(probe.requiredSkillIds);
    const touchedIndices = [...touched.keys()].sort((a, b) => a - b);
    if (touchedIndices.length < 2) return false;
    if (!this.checkCrossComponentMerge(touchedIndices).feasible) return false;

    const likeMastered = observation.correct ? 1 - probe.slip : probe.slip;
    const likeUnmastered = observation.correct ? probe.guess : 1 - probe.guess;
    if (likeMastered <= 0 && likeUnmastered <= 0) return false;

    let allHaveMasteredState = true;
    let someHasUnmasteredState = false;
    for (const [cIdx, reqMask] of touched.entries()) {
      const comp = this._components[cIdx]!;
      let hasFinite = false;
      let hasMastered = false;
      let hasUnmastered = false;
      for (let i = 0; i < comp.states.length; i++) {
        if (!Number.isFinite(comp.logW[i]!)) continue;
        hasFinite = true;
        if ((comp.states[i]! & reqMask) === reqMask) hasMastered = true;
        else hasUnmastered = true;
        if (hasMastered && hasUnmastered) break;
      }
      if (!hasFinite) return false;
      if (!hasMastered) allHaveMasteredState = false;
      if (hasUnmastered) someHasUnmasteredState = true;
    }
    return (likeMastered > 0 && allHaveMasteredState) || (likeUnmastered > 0 && someHasUnmasteredState);
  }

  getSkillMarginals(): Record<string, number> {
    const marginals: Record<string, number> = {};
    for (const comp of this.components) {
      for (let k = 0; k < comp.skillIds.length; k++) {
        const bit = 1n << BigInt(k);
        let sum = 0;
        for (let s = 0; s < comp.states.length; s++) if ((comp.states[s]! & bit) !== 0n) sum += comp.w[s]!;
        defineRecordEntry(marginals, comp.skillIds[k]!, clamp(sum, 0, 1));
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
        defineRecordEntry(outerFringeBySkill, skillId, clamp(outerSum, 0, 1));
        defineRecordEntry(parentsSatisfiedBySkill, skillId, clamp(parentsSum, 0, 1));
      }
    }
    return { outerFringeBySkill, parentsSatisfiedBySkill };
  }

  getSkillCovariance(marginals = this.getSkillMarginals()): Record<string, Record<string, number>> {
    const covariance: Record<string, Record<string, number>> = {};
    const allSkills = this.graph.topoOrder;
    for (const id of allSkills) defineRecordEntry(covariance, id, {});
    for (const comp of this.components) {
      for (let i = 0; i < comp.skillIds.length; i++) {
        const u = comp.skillIds[i]!;
        const piU = readRecordEntry(marginals, u)!;
        const rowU = readRecordEntry(covariance, u)!;
        defineRecordEntry(rowU, u, clamp(piU * (1 - piU), 0, 0.25));
        for (let j = i + 1; j < comp.skillIds.length; j++) {
          const v = comp.skillIds[j]!;
          const piV = readRecordEntry(marginals, v)!;
          const both = (1n << BigInt(i)) | (1n << BigInt(j));
          let eUV = 0;
          for (let s = 0; s < comp.states.length; s++) if ((comp.states[s]! & both) === both) eUV += comp.w[s]!;
          const cov = Math.abs(eUV - piU * piV) < EPSILON ? 0 : eUV - piU * piV;
          defineRecordEntry(rowU, v, cov);
          defineRecordEntry(readRecordEntry(covariance, v)!, u, cov);
        }
      }
    }
    if (allSkills.length <= 100) {
      for (const u of allSkills) {
        const rowU = readRecordEntry(covariance, u)!;
        for (const v of allSkills) if (!Object.hasOwn(rowU, v)) defineRecordEntry(rowU, v, 0);
      }
    }
    return covariance;
  }

  buildPriorSnapshot(options: { snapshotId?: string; courseId?: string; learnerId?: string; createdAtMs?: number } = {}): KstSnapshotV1 {
    const piBySkill = this.getSkillMarginals();
    const { outerFringeBySkill, parentsSatisfiedBySkill } = this.getOuterFringeAndParentsSatisfied();
    const skillCovariance = this.getSkillCovariance(piBySkill);
    const prerequisitesBySkill: Record<string, readonly string[]> = {};
    for (const [skillId, rec] of this.graph.skillsById.entries()) {
      defineRecordEntry(prerequisitesBySkill, skillId, Object.freeze([...rec.prerequisiteIds]));
    }
    Object.freeze(prerequisitesBySkill);
    const componentJointWeights: KstComponentJointWeights[] = this.components.map(comp => {
      const wByState: Record<string, number> = {};
      for (let s = 0; s < comp.states.length; s++) {
        const mastered = comp.skillIds.filter((_, k) => (comp.states[s]! & (1n << BigInt(k))) !== 0n);
        defineRecordEntry(wByState, canonicalStateKey(mastered), comp.w[s]!);
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
      totalFeasibleStateCountExact: this.totalFeasibleStateCountExact,
      wByState: this.approximationMode === "exact" ? componentJointWeights[0]!.wByState : null,
      componentJointWeights,
      piBySkill,
      outerFringeBySkill,
      parentsSatisfiedBySkill,
      skillCovariance,
      prerequisitesBySkill,
      consumedProbeObservationIds: this.consumedProbeObservationIds,
    };
  }
}

export const createKstStateSpace = (skills: readonly DiagnosticSkillNode[]): KstStateSpace => new KstStateSpace(skills);

export const buildKstPriorSnapshot = (
  stateSpace: KstStateSpace,
  options: { snapshotId?: string; courseId?: string; learnerId?: string; createdAtMs?: number } = {},
): KstSnapshotV1 => stateSpace.buildPriorSnapshot(options);

export const getSkillCovariance = (snapshot: KstSnapshotV1, skillA: string, skillB: string): number => {
  if (!snapshot.skillCovariance || typeof snapshot.skillCovariance !== "object" || Array.isArray(snapshot.skillCovariance)) {
    throw new DiagnosticPlacementError("VALIDATION", "KstSnapshotV1 skillCovariance must be a non-null record");
  }
  const row = readRecordEntry(snapshot.skillCovariance, skillA);
  if (row === undefined) return 0;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new DiagnosticPlacementError("VALIDATION", `Invalid skillCovariance row for ${skillA}`);
  }
  const val = readRecordEntry(row, skillB);
  if (val === undefined) return 0;
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new DiagnosticPlacementError("VALIDATION", `Non-finite skillCovariance entry for (${skillA}, ${skillB})`);
  }
  return val;
};

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
  const consumedIdsCanonical = snapshot.consumedProbeObservationIds.map(id => id.trim()).filter(id => id.length > 0);
  const consumedSet = new Set(consumedIdsCanonical);
  const seenBatchIds = new Set<string>();
  const directObservations: T[] = [];
  const strippedConsumedObservations: PartitionedObservation<T>[] = [];
  const annotatedObservations: PartitionedObservation<T>[] = [];
  for (const obs of observations) {
    const rawId = typeof obs.observationId === "string" ? obs.observationId : "";
    const trimmedId = rawId.trim();
    const hasNonBlankId = trimmedId.length > 0;
    const alreadyConsumed = hasNonBlankId && consumedSet.has(trimmedId);
    const duplicateInBatch = hasNonBlankId && !alreadyConsumed && seenBatchIds.has(trimmedId);
    const unassistedValid = "correct" in obs
      ? isUnassistedValidObservation(obs as { correct: unknown; channel?: string; unassisted?: boolean; assisted?: boolean; hinted?: boolean; valid?: boolean })
      : obs.valid !== false && obs.assisted !== true && obs.hinted !== true && obs.unassisted !== false
        && (obs.channel === undefined || obs.channel === "unassisted");
    const eligibleForDirectUpdate = hasNonBlankId && !alreadyConsumed && !duplicateInBatch && unassistedValid;
    const eligibleForFirePropagation = eligibleForDirectUpdate && (obs.eligibleForFirePropagation ?? true);

    if (eligibleForDirectUpdate) {
      seenBatchIds.add(trimmedId);
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
    consumedObservationIds: [...consumedSet],
  };
}

export function buildSkillBeliefFromKstSnapshot(
  snapshot: KstSnapshotV1,
  skillId: string,
  meta: { workspaceId: string; learnerId: string; courseId: string; confirmedSkillVersion: string | number },
): SkillBeliefV1 {
  validateKstSnapshot(snapshot);
  const marginal = readRecordEntry(snapshot.piBySkill, skillId);
  if (marginal === undefined) throw new DiagnosticPlacementError("VALIDATION", `Skill ${skillId} missing from KstSnapshotV1`);
  const bounded = clamp(marginal, 1e-9, 1 - 1e-9);
  return createSkillBelief({ ...meta, abilityMean: Math.log(bounded) - Math.log1p(-bounded) });
}

export function updateSkillMasteryFromKstSnapshot(
  snapshot: KstSnapshotV1,
  skillId: string,
  observations: readonly DownstreamSkillProbeObservation[],
  beliefMeta?: { workspaceId: string; learnerId: string; courseId: string; confirmedSkillVersion: string | number },
): DownstreamSkillPosteriorResult {
  validateKstSnapshot(snapshot);
  const prior = readRecordEntry(snapshot.piBySkill, skillId);
  if (prior === undefined) throw new DiagnosticPlacementError("VALIDATION", `Skill ${skillId} missing from KstSnapshotV1`);
  const partitioned = partitionObservationsAgainstKstSnapshot(snapshot, observations);
  const appliedObservationIds: string[] = [];
  let posterior = clamp(prior, 0, 1);

  if (posterior > 0 && posterior < 1) {
    let logOdds = Math.log(posterior) - Math.log1p(-posterior);
    for (const obs of partitioned.unconsumedObservations) {
      if (obs.skillId !== skillId || !isUnassistedValidObservation(obs)) continue;
      if (!Number.isFinite(obs.slip) || obs.slip < 0 || obs.slip >= 0.49
        || !Number.isFinite(obs.guess) || obs.guess < 0 || obs.guess >= 0.49 || !(1 - obs.slip > obs.guess)) {
        throw new DiagnosticPlacementError("VALIDATION", `Invalid slip/guess on observation ${obs.observationId}`);
      }
      const pM = obs.correct ? 1 - obs.slip : obs.slip;
      const pU = obs.correct ? obs.guess : 1 - obs.guess;
      appliedObservationIds.push(obs.observationId.trim());
      if (pM === 0 && pU > 0) { posterior = 0; break; }
      if (pU === 0 && pM > 0) { posterior = 1; break; }
      if (pM > 0 && pU > 0) logOdds += Math.log(pM) - Math.log(pU);
    }
    if (posterior > 0 && posterior < 1) {
      posterior = logOdds >= 0 ? 1 / (1 + Math.exp(-logOdds)) : Math.exp(logOdds) / (1 + Math.exp(logOdds));
    }
  }

  const boundedPost = clamp(posterior, 1e-9, 1 - 1e-9);
  const belief = beliefMeta
    ? createSkillBelief({ ...beliefMeta, abilityMean: Math.log(boundedPost) - Math.log1p(-boundedPost) })
    : undefined;
  return { skillId, priorProbability: prior, posteriorProbability: posterior, appliedObservationIds, partitioned, ...(belief ? { belief } : {}) };
}
