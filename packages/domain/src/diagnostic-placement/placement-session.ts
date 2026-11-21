import { KstStateSpace, certifyKstSnapshot, defineRecordEntry, validateProbeItem } from "./kst-state-space";
import {
  DiagnosticPlacementError,
  MAX_EXACT_KST_STATES,
  MAX_PLACEMENT_BUDGET_SECONDS,
  MAX_PLACEMENT_ITEMS_CEILING,
  BLOCKED_UI_LABEL,
  DEFAULT_HIGH_VALUE_WEIGHT_THRESHOLD,
  DEFAULT_MAX_PLACEMENT_ITEMS,
  DEFAULT_MIN_PLACEMENT_ITEMS,
  DEFAULT_PLACEMENT_BUDGET_SECONDS,
  DEFAULT_READY_THRESHOLD,
  DEFAULT_SKIP_THRESHOLD,
  DELAYED_CHECK_AFTER_HOURS,
  READY_UI_LABEL,
  SKIP_CANDIDATE_UI_LABEL,
  type ChapterQuotaInput,
  type DiagnosticProbeItem,
  type DiagnosticProbeObservation,
  type DiagnosticSkillNode,
  type KstComponentMode,
  type KstObservationUpdateResult,
  type KstSnapshotV1,
  type PlacementSelectionResult,
  type PlacementSessionConfig,
  type PlacementStopReason,
  type SkillPlacementRoute,
} from "./types";

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
type NormalizedQuota = { minItems: number; maxItems: number };

function normalizeChapterQuotas(input: Readonly<Record<string, ChapterQuotaInput>> | undefined, maxItems: number): ReadonlyMap<string, NormalizedQuota> {
  const result = new Map<string, NormalizedQuota>();
  if (!input) return result;
  let totalMin = 0;
  for (const [chapterId, quota] of Object.entries(input)) {
    const minItems = typeof quota === "number" ? quota : quota.minItems ?? 0;
    const chapterMax = typeof quota === "number" ? Infinity : quota.maxItems ?? Infinity;
    if (!Number.isInteger(minItems) || minItems < 0) throw new DiagnosticPlacementError("VALIDATION", `Invalid minItems quota for chapter ${chapterId}`);
    if (chapterMax !== Infinity && (!Number.isInteger(chapterMax) || chapterMax < minItems)) throw new DiagnosticPlacementError("VALIDATION", `Invalid maxItems quota for chapter ${chapterId}`);
    totalMin += minItems;
    result.set(chapterId, { minItems, maxItems: chapterMax });
  }
  if (totalMin > maxItems) throw new DiagnosticPlacementError("VALIDATION", "Sum of minimum chapter quotas exceeds session maxItems");
  return result;
}

export function classifyPlacementRoutes(
  source: KstStateSpace | KstSnapshotV1,
  skills: readonly DiagnosticSkillNode[],
  options: { skipThreshold?: number; readyThreshold?: number; highValueWeightThreshold?: number } = {},
): SkillPlacementRoute[] {
  const skipThreshold = options.skipThreshold ?? DEFAULT_SKIP_THRESHOLD;
  const readyThreshold = options.readyThreshold ?? DEFAULT_READY_THRESHOLD;
  const highValueWeightThreshold = options.highValueWeightThreshold ?? DEFAULT_HIGH_VALUE_WEIGHT_THRESHOLD;
  if (!Number.isFinite(skipThreshold) || !Number.isFinite(readyThreshold) || readyThreshold <= 0 || skipThreshold > 1 || readyThreshold > skipThreshold) {
    throw new DiagnosticPlacementError("VALIDATION", "Invalid route classification thresholds");
  }
  if (!Number.isFinite(highValueWeightThreshold) || highValueWeightThreshold < 0) {
    throw new DiagnosticPlacementError("VALIDATION", "Invalid highValueWeightThreshold");
  }

  const snapshot = source instanceof KstStateSpace ? source.buildPriorSnapshot() : source;
  const certified = source instanceof KstStateSpace
    ? {
        piBySkill: new Map(Object.entries(snapshot.piBySkill)),
        parentsSatisfiedBySkill: new Map(Object.entries(snapshot.parentsSatisfiedBySkill)),
        outerFringeBySkill: new Map(Object.entries(snapshot.outerFringeBySkill)),
      }
    : certifyKstSnapshot(snapshot, skills);
  const componentModeBySkill = new Map<string, KstComponentMode>();
  for (const comp of snapshot.componentJointWeights) {
    for (const id of comp.skillIds) {
      if (componentModeBySkill.get(id) === "bounded_component_envelope") continue;
      componentModeBySkill.set(id, comp.approximationMode);
    }
  }
  const hasExplicitComponentModes = snapshot.componentJointWeights.length > 0;

  return skills.map(skill => {
    const pi = certified.piBySkill.get(skill.skillId);
    const outerFringe = certified.outerFringeBySkill.get(skill.skillId);
    const parentsSatisfied = certified.parentsSatisfiedBySkill.get(skill.skillId);
    if (pi === undefined || outerFringe === undefined || parentsSatisfied === undefined) {
      throw new DiagnosticPlacementError("VALIDATION", `Skill ${skill.skillId} missing from KST state`);
    }
    const syllabusWeight = skill.syllabusWeight ?? 0;
    const parents = [...new Set(skill.prerequisiteIds ?? [])].sort(cmpStr);
    for (const p of parents) {
      if (!certified.piBySkill.has(p)) {
        throw new DiagnosticPlacementError("VALIDATION", `Prerequisite ${p} of ${skill.skillId} missing from KST state`);
      }
    }
    const base = {
      skillId: skill.skillId,
      chapterId: skill.chapterId,
      masteryProbability: pi,
      outerFringeProbability: outerFringe,
      parentsSatisfiedProbability: parentsSatisfied,
      syllabusWeight,
      countsTowardMastery: false as const,
      verificationStatus: "unverified_inferred" as const,
    };

    if (pi >= skipThreshold) {
      const holdoutVerificationRequired = syllabusWeight >= highValueWeightThreshold;
      return {
        ...base,
        route: "inferred_skip_candidate",
        uiLabel: SKIP_CANDIDATE_UI_LABEL,
        holdoutVerificationRequired,
        delayedCheckAfterHours: holdoutVerificationRequired ? DELAYED_CHECK_AFTER_HOURS : null,
        missingPrerequisiteIds: [],
      };
    }

    const exactCertified =
      hasExplicitComponentModes &&
      [skill.skillId, ...parents].every(id => componentModeBySkill.get(id) === "exact");
    if (exactCertified && outerFringe >= readyThreshold) {
      return { ...base, route: "inferred_ready", uiLabel: READY_UI_LABEL, holdoutVerificationRequired: false, delayedCheckAfterHours: null, missingPrerequisiteIds: [] };
    }
    const weakParents = parents.filter(p => (certified.piBySkill.get(p) ?? 0) < readyThreshold);
    return {
      ...base,
      route: "prerequisite_gap_blocked",
      uiLabel: BLOCKED_UI_LABEL,
      holdoutVerificationRequired: false,
      delayedCheckAfterHours: null,
      missingPrerequisiteIds: weakParents.length > 0 ? weakParents : parents,
    };
  });
}

function minCostFeasibleCompletion(
  availableItems: readonly DiagnosticProbeItem[],
  deficitsByChapter: ReadonlyMap<string, number>,
  headroomByChapter: ReadonlyMap<string, number>,
  kNeeded: number,
  budgetRemaining: number,
): boolean {
  if (kNeeded === 0) return budgetRemaining >= -1e-9;

  const fastestByFamilyChapter = new Map<string, Map<string, DiagnosticProbeItem>>();
  const chaptersPerFamily = new Map<string, Set<string>>();
  for (const item of availableItems) {
    if ((deficitsByChapter.get(item.chapterId) ?? 0) === 0 && (headroomByChapter.get(item.chapterId) ?? Infinity) <= 0) continue;
    let byChapterMap = fastestByFamilyChapter.get(item.familyId);
    if (!byChapterMap) {
      byChapterMap = new Map<string, DiagnosticProbeItem>();
      fastestByFamilyChapter.set(item.familyId, byChapterMap);
    }
    const existing = byChapterMap.get(item.chapterId);
    if (!existing || item.estimatedSeconds < existing.estimatedSeconds ||
      (item.estimatedSeconds === existing.estimatedSeconds && cmpStr(item.itemId, existing.itemId) < 0)) {
      byChapterMap.set(item.chapterId, item);
    }
    if (!chaptersPerFamily.has(item.familyId)) chaptersPerFamily.set(item.familyId, new Set());
    chaptersPerFamily.get(item.familyId)!.add(item.chapterId);
  }

  const deduped: DiagnosticProbeItem[] = [];
  for (const byChapterMap of fastestByFamilyChapter.values()) {
    for (const item of byChapterMap.values()) deduped.push(item);
  }
  if (![...chaptersPerFamily.values()].some(set => set.size > 1)) {
    const byChapter = new Map<string, DiagnosticProbeItem[]>();
    for (const item of deduped) {
      if (!byChapter.has(item.chapterId)) byChapter.set(item.chapterId, []);
      byChapter.get(item.chapterId)!.push(item);
    }
    let minTime = 0;
    let totalDeficit = 0;
    const extraPool: DiagnosticProbeItem[] = [];
    for (const [chapterId, deficit] of deficitsByChapter.entries()) {
      totalDeficit += deficit;
      const items = (byChapter.get(chapterId) ?? []).sort((a, b) => a.estimatedSeconds - b.estimatedSeconds);
      if (items.length < deficit) return false;
      for (let i = 0; i < deficit; i++) minTime += items[i]!.estimatedSeconds;
      const cap = headroomByChapter.get(chapterId) ?? Infinity;
      for (let i = deficit; i < items.length && i - deficit < cap; i++) extraPool.push(items[i]!);
    }
    for (const [chapterId, items] of byChapter.entries()) {
      if (deficitsByChapter.has(chapterId)) continue;
      const cap = headroomByChapter.get(chapterId) ?? Infinity;
      const sorted = [...items].sort((a, b) => a.estimatedSeconds - b.estimatedSeconds);
      for (let i = 0; i < sorted.length && i < cap; i++) extraPool.push(sorted[i]!);
    }
    const extraNeeded = Math.max(0, kNeeded - totalDeficit);
    if (extraPool.length < extraNeeded) return false;
    extraPool.sort((a, b) => a.estimatedSeconds - b.estimatedSeconds);
    for (let i = 0; i < extraNeeded; i++) minTime += extraPool[i]!.estimatedSeconds;
    return minTime <= budgetRemaining + 1e-9;
  }

  // Min-cost max-flow fallback when a familyId spans multiple chapters.
  type Edge = { to: number; rev: number; cap: number; cost: number };
  const families = [...new Set(deduped.map(i => i.familyId))];
  const chapters = [...new Set([...deduped.map(i => i.chapterId), ...deficitsByChapter.keys()])];
  const famIdx = new Map(families.map((f, i) => [f, 1 + i]));
  const chapIdx = new Map(chapters.map((c, i) => [c, 1 + families.length + i]));
  const deficitSink = 1 + families.length + chapters.length;
  const extraSink = deficitSink + 1;
  const sink = extraSink + 1;
  const adj: Edge[][] = Array.from({ length: sink + 1 }, () => []);
  const addEdge = (u: number, v: number, cap: number, cost: number): void => {
    adj[u]!.push({ to: v, rev: adj[v]!.length, cap, cost });
    adj[v]!.push({ to: u, rev: adj[u]!.length - 1, cap: 0, cost: -cost });
  };
  for (const f of families) addEdge(0, famIdx.get(f)!, 1, 0);
  for (const item of deduped) addEdge(famIdx.get(item.familyId)!, chapIdx.get(item.chapterId)!, 1, item.estimatedSeconds);
  let totalDeficit = 0;
  for (const c of chapters) {
    const def = deficitsByChapter.get(c) ?? 0;
    const cap = headroomByChapter.get(c) ?? kNeeded;
    totalDeficit += def;
    if (def > 0) addEdge(chapIdx.get(c)!, deficitSink, def, 0);
    if (cap > 0) addEdge(chapIdx.get(c)!, extraSink, Math.min(kNeeded, cap), 0);
  }
  if (totalDeficit > kNeeded) return false;
  addEdge(deficitSink, sink, totalDeficit, 0);
  addEdge(extraSink, sink, kNeeded - totalDeficit, 0);

  let flow = 0;
  let totalCost = 0;
  while (flow < kNeeded) {
    const dist = Array<number>(sink + 1).fill(Infinity);
    const parentNode = Array<number>(sink + 1).fill(-1);
    const parentEdge = Array<number>(sink + 1).fill(-1);
    const inQ = Array<boolean>(sink + 1).fill(false);
    dist[0] = 0;
    const q = [0];
    inQ[0] = true;
    for (let head = 0; head < q.length; head++) {
      const u = q[head]!;
      inQ[u] = false;
      for (let ei = 0; ei < adj[u]!.length; ei++) {
        const e = adj[u]![ei]!;
        if (e.cap > 0 && dist[u]! + e.cost + 1e-12 < dist[e.to]!) {
          dist[e.to] = dist[u]! + e.cost;
          parentNode[e.to] = u;
          parentEdge[e.to] = ei;
          if (!inQ[e.to]) { q.push(e.to); inQ[e.to] = true; }
        }
      }
    }
    if (!Number.isFinite(dist[sink]!)) return false;
    flow++;
    totalCost += dist[sink]!;
    for (let v = sink; v !== 0; v = parentNode[v]!) {
      const u = parentNode[v]!;
      const ei = parentEdge[v]!;
      adj[u]![ei]!.cap -= 1;
      adj[v]![adj[u]![ei]!.rev]!.cap += 1;
    }
  }
  return totalCost <= budgetRemaining + 1e-9;
}

export class DiagnosticPlacementSession {
  readonly stateSpace: KstStateSpace;
  readonly skills: readonly DiagnosticSkillNode[];
  readonly candidatePool: readonly DiagnosticProbeItem[];
  readonly minItems: number;
  readonly maxItems: number;
  readonly totalBudgetSeconds: number;
  readonly earlyStopMinMutualInfoBits: number;

  private readonly probeById = new Map<string, DiagnosticProbeItem>();
  private readonly chapterQuotas: ReadonlyMap<string, NormalizedQuota>;
  private readonly routeDefaults: { skipThreshold?: number; readyThreshold?: number; highValueWeightThreshold?: number };
  private readonly usedItemIds = new Set<string>();
  private readonly usedFamilyIds = new Set<string>();
  private readonly seenObservationIds = new Set<string>();
  private readonly chapterCounts = new Map<string, number>();

  private remainingBudgetSeconds: number;
  private administeredCount = 0;
  private appliedEvidenceCount = 0;
  private pendingProbeId: string | null = null;
  private stopReason: PlacementStopReason | null = null;

  constructor(input: { skills: readonly DiagnosticSkillNode[]; candidatePool: readonly DiagnosticProbeItem[]; config?: PlacementSessionConfig }) {
    const config = input.config ?? {};
    this.minItems = config.minItems ?? DEFAULT_MIN_PLACEMENT_ITEMS;
    this.maxItems = config.maxItems ?? DEFAULT_MAX_PLACEMENT_ITEMS;
    this.totalBudgetSeconds = config.totalBudgetSeconds ?? DEFAULT_PLACEMENT_BUDGET_SECONDS;
    this.earlyStopMinMutualInfoBits = config.earlyStopMinMutualInfoBits ?? 1e-4;
    if (!Number.isInteger(this.minItems) || this.minItems < 1) throw new DiagnosticPlacementError("VALIDATION", "minItems must be an integer >= 1");
    if (!Number.isInteger(this.maxItems) || this.maxItems < this.minItems || this.maxItems > MAX_PLACEMENT_ITEMS_CEILING) {
      throw new DiagnosticPlacementError("VALIDATION", `maxItems must be an integer in [minItems, ${MAX_PLACEMENT_ITEMS_CEILING}]`);
    }
    if (!Number.isFinite(this.totalBudgetSeconds) || this.totalBudgetSeconds <= 0 || this.totalBudgetSeconds > MAX_PLACEMENT_BUDGET_SECONDS) {
      throw new DiagnosticPlacementError("VALIDATION", `totalBudgetSeconds must be in (0, ${MAX_PLACEMENT_BUDGET_SECONDS}]`);
    }
    if (!Number.isFinite(this.earlyStopMinMutualInfoBits) || this.earlyStopMinMutualInfoBits < 0) {
      throw new DiagnosticPlacementError("VALIDATION", "earlyStopMinMutualInfoBits must be finite and >= 0");
    }

    this.skills = input.skills;
    this.stateSpace = new KstStateSpace(input.skills);
    this.chapterQuotas = normalizeChapterQuotas(config.chapterQuotas, this.maxItems);
    this.routeDefaults = { skipThreshold: config.skipThreshold, readyThreshold: config.readyThreshold, highValueWeightThreshold: config.highValueWeightThreshold };
    for (const probe of input.candidatePool) {
      if (this.probeById.has(probe.itemId)) throw new DiagnosticPlacementError("VALIDATION", `Duplicate probe itemId ${probe.itemId}`);
      validateProbeItem(probe, this.stateSpace.graph.skillsById);
      this.probeById.set(probe.itemId, probe);
    }
    this.candidatePool = input.candidatePool;
    this.remainingBudgetSeconds = this.totalBudgetSeconds;
  }

  private allChapterQuotasMet(): boolean {
    for (const [chapterId, q] of this.chapterQuotas.entries()) if ((this.chapterCounts.get(chapterId) ?? 0) < q.minItems) return false;
    return true;
  }

  private canCompleteSessionWith(
    candidate: DiagnosticProbeItem,
    budgetSeconds = this.remainingBudgetSeconds,
    candidateCost = candidate.estimatedSeconds,
    mergeCandidateComponents = true,
  ): boolean {
    if (!this.stateSpace.canEvaluateProbe(candidate)) return false;
    if (this.usedItemIds.size + 1 > this.maxItems) return false;
    const budgetAfter = budgetSeconds - candidateCost;
    if (budgetAfter < -1e-9) return false;

    const nextChapterCount = (this.chapterCounts.get(candidate.chapterId) ?? 0) + 1;
    const candidateQuota = this.chapterQuotas.get(candidate.chapterId);
    if (candidateQuota && nextChapterCount > candidateQuota.maxItems) return false;

    const initRemMin = new Map<string, number>();
    const initRemMaxCap = new Map<string, number>();
    let initTotalDeficit = 0;
    for (const [chapterId, quota] of this.chapterQuotas.entries()) {
      const count = chapterId === candidate.chapterId ? nextChapterCount : (this.chapterCounts.get(chapterId) ?? 0);
      const deficit = Math.max(0, quota.minItems - count);
      if (deficit > 0) initRemMin.set(chapterId, deficit);
      initTotalDeficit += deficit;
      initRemMaxCap.set(chapterId, quota.maxItems === Infinity ? Infinity : Math.max(0, quota.maxItems - count));
    }
    const minAfter = Math.max(0, this.minItems - (this.usedItemIds.size + 1));
    const maxAfter = this.maxItems - (this.usedItemIds.size + 1);
    const initKNeeded = Math.max(initTotalDeficit, minAfter);
    if (initKNeeded > maxAfter) return false;
    if (initKNeeded === 0) return true;

    const meta = this.stateSpace.getComponentMetadata();
    const compIndexBySkill = this.stateSpace.componentIndexBySkill;
    const groupModes = meta.map(m => m.approximationMode);
    const maxExactStates = BigInt(MAX_EXACT_KST_STATES);

    const origCompsCache = new Map<string, readonly number[]>();
    const getOrigComps = (item: DiagnosticProbeItem): readonly number[] => {
      let cached = origCompsCache.get(item.itemId);
      if (!cached) {
        const set = new Set<number>();
        for (const skillId of item.requiredSkillIds) {
          const idx = compIndexBySkill.get(skillId);
          if (idx !== undefined) set.add(idx);
        }
        cached = [...set];
        origCompsCache.set(item.itemId, cached);
      }
      return cached;
    };

    type MergeOutcome =
      | { ok: false }
      | { ok: true; groupsCount: number; groupSig: string; nextCompToGroup: number[]; nextGroupCounts: bigint[] };

    const evalMerge = (
      item: DiagnosticProbeItem,
      compToGroup: number[],
      groupCounts: bigint[],
    ): MergeOutcome => {
      const origComps = getOrigComps(item);
      if (origComps.length <= 1) {
        return { ok: true, groupsCount: origComps.length, groupSig: "single", nextCompToGroup: compToGroup, nextGroupCounts: groupCounts };
      }
      const gSet = new Set<number>();
      for (const orig of origComps) gSet.add(compToGroup[orig]!);
      if (gSet.size <= 1) {
        return { ok: true, groupsCount: 1, groupSig: "single", nextCompToGroup: compToGroup, nextGroupCounts: groupCounts };
      }
      let prod = 1n;
      let targetGroup = Infinity;
      const gSorted = [...gSet].sort((a, b) => a - b);
      for (const g of gSorted) {
        if (groupModes[g] !== "exact") return { ok: false };
        prod *= groupCounts[g]!;
        if (prod > maxExactStates) return { ok: false };
        if (g < targetGroup) targetGroup = g;
      }
      const nextCompToGroup = compToGroup.slice();
      for (let i = 0; i < nextCompToGroup.length; i++) {
        if (gSet.has(nextCompToGroup[i]!)) nextCompToGroup[i] = targetGroup;
      }
      const nextGroupCounts = groupCounts.slice();
      nextGroupCounts[targetGroup] = prod;
      return { ok: true, groupsCount: gSet.size, groupSig: gSorted.join(","), nextCompToGroup, nextGroupCounts };
    };

    const startCompToGroup = Array.from({ length: meta.length }, (_, i) => i);
    const startGroupCounts = meta.map(m => m.stateCount);
    const afterCandidate: MergeOutcome = mergeCandidateComponents
      ? evalMerge(candidate, startCompToGroup, startGroupCounts)
      : { ok: true, groupsCount: 1, groupSig: "single", nextCompToGroup: startCompToGroup, nextGroupCounts: startGroupCounts };
    if (!afterCandidate.ok) return false;

    const rawRemaining = this.candidatePool
      .filter(item =>
        item.itemId !== candidate.itemId &&
        item.familyId !== candidate.familyId &&
        !this.usedItemIds.has(item.itemId) &&
        !this.usedFamilyIds.has(item.familyId) &&
        item.estimatedSeconds <= budgetAfter + 1e-9 &&
        ((initRemMaxCap.get(item.chapterId) ?? Infinity) > 0),
      )
      .sort((a, b) => (a.estimatedSeconds - b.estimatedSeconds) || cmpStr(a.itemId, b.itemId));

    // Dominance pruning using collision-free 3-level nested Map (familyId -> chapterId -> groupSig)
    const bestByEquiv = new Map<string, Map<string, Map<string, DiagnosticProbeItem>>>();
    for (const item of rawRemaining) {
      const outcome = evalMerge(item, afterCandidate.nextCompToGroup, afterCandidate.nextGroupCounts);
      if (!outcome.ok) continue;
      let byChap = bestByEquiv.get(item.familyId);
      if (!byChap) {
        byChap = new Map();
        bestByEquiv.set(item.familyId, byChap);
      }
      let bySig = byChap.get(item.chapterId);
      if (!bySig) {
        bySig = new Map();
        byChap.set(item.chapterId, bySig);
      }
      if (!bySig.has(outcome.groupSig)) bySig.set(outcome.groupSig, item);
    }

    const alwaysSinglePool: DiagnosticProbeItem[] = [];
    const potentialMergePool: DiagnosticProbeItem[] = [];
    const famAppearanceCount = new Map<string, number>();
    for (const byChap of bestByEquiv.values()) {
      for (const bySig of byChap.values()) {
        for (const item of bySig.values()) {
          famAppearanceCount.set(item.familyId, (famAppearanceCount.get(item.familyId) ?? 0) + 1);
          const out = evalMerge(item, afterCandidate.nextCompToGroup, afterCandidate.nextGroupCounts);
          if (out.ok && out.groupsCount <= 1) alwaysSinglePool.push(item);
          else if (out.ok) potentialMergePool.push(item);
        }
      }
    }
    alwaysSinglePool.sort((a, b) => (a.estimatedSeconds - b.estimatedSeconds) || cmpStr(a.itemId, b.itemId));
    potentialMergePool.sort((a, b) => (a.estimatedSeconds - b.estimatedSeconds) || cmpStr(a.itemId, b.itemId));

    // Fast path: pure-single completion tested immediately before entering merge DFS
    const initHeadroom = new Map<string, number>();
    for (const [ch, cap] of initRemMaxCap.entries()) {
      initHeadroom.set(ch, cap === Infinity ? Infinity : Math.max(0, cap - (initRemMin.get(ch) ?? 0)));
    }
    if (alwaysSinglePool.length >= initKNeeded && minCostFeasibleCompletion(alwaysSinglePool, initRemMin, initHeadroom, initKNeeded, budgetAfter)) {
      return true;
    }

    const pickedFams = new Set<string>();
    const pickedMergeItems = new Set<string>();
    const bannedMergeIds = new Set<string>();
    const failedBudgetMemo = new Map<string, number>();

    const getCanonicalUnionSig = (compToGroup: number[]): string => {
      const members = new Map<number, number[]>();
      for (let i = 0; i < compToGroup.length; i++) {
        const g = compToGroup[i]!;
        if (!members.has(g)) members.set(g, []);
        members.get(g)!.push(i);
      }
      const multiBlocks: string[] = [];
      for (const grp of members.values()) {
        if (grp.length > 1) multiBlocks.push(grp.join("+"));
      }
      multiBlocks.sort();
      return multiBlocks.join("|");
    };

    type MergerCandidate = { item: DiagnosticProbeItem; outcome: Extract<MergeOutcome, { ok: true }> };
    type DfsBranchEntry = { item: DiagnosticProbeItem; outcome: Extract<MergeOutcome, { ok: true }>; equivNonConflictingIds: string[] };
    type DfsBudgetCounter = { visited: number; limit: number; aborted: boolean };

    const dedupMergers = (entries: readonly MergerCandidate[]): DfsBranchEntry[] => {
      const nonConflictingByChapSig = new Map<string, Map<string, DfsBranchEntry>>();
      const result: DfsBranchEntry[] = [];
      for (const entry of entries) {
        if (famAppearanceCount.get(entry.item.familyId) === 1) {
          let bySig = nonConflictingByChapSig.get(entry.item.chapterId);
          if (!bySig) {
            bySig = new Map();
            nonConflictingByChapSig.set(entry.item.chapterId, bySig);
          }
          const existing = bySig.get(entry.outcome.groupSig);
          if (existing) {
            existing.equivNonConflictingIds.push(entry.item.itemId);
            continue;
          }
          const branch: DfsBranchEntry = { item: entry.item, outcome: entry.outcome, equivNonConflictingIds: [entry.item.itemId] };
          bySig.set(entry.outcome.groupSig, branch);
          result.push(branch);
        } else {
          result.push({ item: entry.item, outcome: entry.outcome, equivNonConflictingIds: [entry.item.itemId] });
        }
      }
      return result;
    };

    const dfs = (
      multiPickedCount: number,
      remBudget: number,
      remMinMap: ReadonlyMap<string, number>,
      totalRemMin: number,
      remMaxCapMap: ReadonlyMap<string, number>,
      compToGroup: number[],
      groupCounts: bigint[],
      isRoot: boolean,
      budgetCounter: DfsBudgetCounter,
    ): boolean => {
      const minRemaining = Math.max(0, minAfter - multiPickedCount);
      const maxRemaining = maxAfter - multiPickedCount;
      const kSingleNeeded = Math.max(totalRemMin, minRemaining);
      if (kSingleNeeded > maxRemaining) return false;
      if (kSingleNeeded === 0) return remBudget >= -1e-9;

      if (!isRoot) {
        if (budgetCounter.visited >= budgetCounter.limit) {
          budgetCounter.aborted = true;
          return false;
        }
        budgetCounter.visited += 1;
      }

      const sortedMin = [...remMinMap.entries()].sort((a, b) => cmpStr(a[0], b[0]));
      const sortedMax = [...remMaxCapMap.entries()].filter(([, v]) => v !== Infinity).sort((a, b) => cmpStr(a[0], b[0]));
      const sortedFams = [...pickedFams].sort(cmpStr);
      const sortedBanned = [...bannedMergeIds].sort(cmpStr);
      const memoKey = JSON.stringify([getCanonicalUnionSig(compToGroup), multiPickedCount, minRemaining, sortedMin, sortedMax, sortedFams, sortedBanned]);
      const prevFailBudget = failedBudgetMemo.get(memoKey);
      if (prevFailBudget !== undefined && prevFailBudget >= remBudget - 1e-9) return false;

      const failAndMemo = (): false => {
        if (prevFailBudget === undefined || remBudget > prevFailBudget) {
          failedBudgetMemo.set(memoKey, remBudget);
        }
        return false;
      };

      const headroomNow = new Map<string, number>();
      for (const [ch, cap] of remMaxCapMap.entries()) {
        headroomNow.set(ch, cap === Infinity ? Infinity : Math.max(0, cap - (remMinMap.get(ch) ?? 0)));
      }

      // Single-group probes NEVER merge KST components: partition remaining probes relative to current compToGroup
      const currentSingles: DiagnosticProbeItem[] = [];
      for (const item of alwaysSinglePool) {
        if (pickedFams.has(item.familyId)) continue;
        if (item.estimatedSeconds > remBudget + 1e-9) continue;
        if ((remMaxCapMap.get(item.chapterId) ?? Infinity) <= 0) continue;
        currentSingles.push(item);
      }

      const activeMergers: MergerCandidate[] = [];
      for (const item of potentialMergePool) {
        if (pickedMergeItems.has(item.itemId) || pickedFams.has(item.familyId)) continue;
        if (item.estimatedSeconds > remBudget + 1e-9) continue;
        if ((remMaxCapMap.get(item.chapterId) ?? Infinity) <= 0) continue;
        const outcome = evalMerge(item, compToGroup, groupCounts);
        if (!outcome.ok) continue;
        if (outcome.groupsCount <= 1) {
          currentSingles.push(item);
        } else if (!bannedMergeIds.has(item.itemId)) {
          activeMergers.push({ item, outcome });
        }
      }

      // Test pure-single completion first at every node
      if (currentSingles.length >= kSingleNeeded && minCostFeasibleCompletion(currentSingles, remMinMap, headroomNow, kSingleNeeded, remBudget)) {
        return true;
      }

      if (multiPickedCount >= maxAfter || activeMergers.length === 0) return failAndMemo();

      const upperItems = [...currentSingles, ...activeMergers.map(m => m.item)];
      if (upperItems.length < kSingleNeeded || !minCostFeasibleCompletion(upperItems, remMinMap, headroomNow, kSingleNeeded, remBudget)) {
        return failAndMemo();
      }

      // Unit-propagate chapter lower bounds and branch on forced chapters using MRV (fewest distinct merger choices)
      const singlesByChap = new Map<string, number>();
      for (const item of currentSingles) singlesByChap.set(item.chapterId, (singlesByChap.get(item.chapterId) ?? 0) + 1);
      const mergersByChap = new Map<string, MergerCandidate[]>();
      for (const entry of activeMergers) {
        let list = mergersByChap.get(entry.item.chapterId);
        if (!list) {
          list = [];
          mergersByChap.set(entry.item.chapterId, list);
        }
        list.push(entry);
      }

      let forcedChapter: string | null = null;
      let forcedBranches: DfsBranchEntry[] | null = null;
      let bestShortfall = 0;
      for (const [ch, reqMin] of remMinMap.entries()) {
        const sCount = singlesByChap.get(ch) ?? 0;
        const chMergers = mergersByChap.get(ch) ?? [];
        if (sCount + chMergers.length < reqMin) return failAndMemo();
        if (sCount < reqMin) {
          const chBranches = dedupMergers(chMergers);
          const shortfall = reqMin - sCount;
          if (
            forcedBranches === null ||
            chBranches.length < forcedBranches.length ||
            (chBranches.length === forcedBranches.length &&
              (shortfall > bestShortfall || (shortfall === bestShortfall && cmpStr(ch, forcedChapter!) < 0)))
          ) {
            forcedChapter = ch;
            forcedBranches = chBranches;
            bestShortfall = shortfall;
          }
        }
      }

      const branchSet: DfsBranchEntry[] = forcedBranches !== null
        ? forcedBranches
        : dedupMergers(activeMergers).sort((a, b) => {
            const defA = (remMinMap.get(a.item.chapterId) ?? 0) > 0 ? 0 : 1;
            const defB = (remMinMap.get(b.item.chapterId) ?? 0) > 0 ? 0 : 1;
            return defA - defB || a.item.estimatedSeconds - b.item.estimatedSeconds || cmpStr(a.item.itemId, b.item.itemId);
          });

      const perRootBranchLimit = Math.max(2_000, Math.min(15_000, Math.floor(80_000 / Math.max(1, branchSet.length))));
      const addedBans: string[] = [];
      let anyChildAborted = false;

      for (const entry of branchSet) {
        const { item, outcome } = entry;
        pickedMergeItems.add(item.itemId);
        pickedFams.add(item.familyId);
        const nextMinMap = new Map(remMinMap);
        const curDef = nextMinMap.get(item.chapterId) ?? 0;
        let nextTotalRemMin = totalRemMin;
        if (curDef > 0) {
          nextTotalRemMin -= 1;
          if (curDef <= 1) nextMinMap.delete(item.chapterId);
          else nextMinMap.set(item.chapterId, curDef - 1);
        }
        const nextMaxCap = new Map(remMaxCapMap);
        const prevCap = nextMaxCap.get(item.chapterId) ?? Infinity;
        if (prevCap !== Infinity) nextMaxCap.set(item.chapterId, prevCap - 1);

        const childCounter: DfsBudgetCounter = isRoot
          ? { visited: 0, limit: perRootBranchLimit, aborted: false }
          : budgetCounter;
        const solved = dfs(
          multiPickedCount + 1,
          remBudget - item.estimatedSeconds,
          nextMinMap,
          nextTotalRemMin,
          nextMaxCap,
          outcome.nextCompToGroup,
          outcome.nextGroupCounts,
          false,
          childCounter,
        );
        pickedMergeItems.delete(item.itemId);
        pickedFams.delete(item.familyId);
        if (solved) {
          for (const id of addedBans) bannedMergeIds.delete(id);
          return true;
        }
        if (childCounter.aborted) {
          anyChildAborted = true;
          if (!isRoot) break;
        } else {
          for (const banId of entry.equivNonConflictingIds) {
            if (!bannedMergeIds.has(banId)) {
              bannedMergeIds.add(banId);
              addedBans.push(banId);
            }
          }
        }
      }

      for (const id of addedBans) bannedMergeIds.delete(id);
      if (anyChildAborted || isRoot) return false;
      return failAndMemo();
    };

    return dfs(
      0,
      budgetAfter,
      initRemMin,
      initTotalDeficit,
      initRemMaxCap,
      afterCandidate.nextCompToGroup,
      afterCandidate.nextGroupCounts,
      true,
      { visited: 0, limit: 25_000, aborted: false },
    );
  }

  selectNextProbe(): PlacementSelectionResult {
    const stopped = (reason: PlacementStopReason): PlacementSelectionResult => {
      this.stopReason = reason;
      return { status: "stopped", probe: null, mutualInformationBits: null, stopReason: reason, administeredCount: this.usedItemIds.size, remainingBudgetSeconds: this.remainingBudgetSeconds };
    };
    if (this.stopReason) return stopped(this.stopReason);
    if (this.usedItemIds.size >= this.maxItems) return stopped("max_items_reached");
    if (this.pendingProbeId) {
      const pending = this.probeById.get(this.pendingProbeId);
      if (pending && !this.usedItemIds.has(pending.itemId) && !this.usedFamilyIds.has(pending.familyId)
        && this.canCompleteSessionWith(pending, this.remainingBudgetSeconds)) {
        return { status: "selected", probe: pending, mutualInformationBits: this.stateSpace.computeProbeMutualInformation(pending), stopReason: null, administeredCount: this.usedItemIds.size, remainingBudgetSeconds: this.remainingBudgetSeconds };
      }
      this.pendingProbeId = null;
    }

    const unused = this.candidatePool.filter(item =>
      !this.usedItemIds.has(item.itemId) && !this.usedFamilyIds.has(item.familyId) && this.stateSpace.canEvaluateProbe(item));
    const feasible = unused.filter(item => this.canCompleteSessionWith(item, this.remainingBudgetSeconds));
    if (feasible.length === 0) {
      if (unused.length === 0) return stopped("candidate_pool_exhausted");
      const chapterFamilyFeasibleIgnoringBudget = unused.some(item => this.canCompleteSessionWith(item, Infinity));
      if (!chapterFamilyFeasibleIgnoringBudget) {
        return stopped(this.usedItemIds.size === 0 ? "infeasible_constraints" : "candidate_pool_exhausted");
      }
      return stopped(this.remainingBudgetSeconds < this.totalBudgetSeconds ? "time_budget_exhausted" : "infeasible_constraints");
    }

    let bestProbe = feasible[0]!;
    let bestMi = this.stateSpace.computeProbeMutualInformation(bestProbe);
    for (let i = 1; i < feasible.length; i++) {
      const cand = feasible[i]!;
      const mi = this.stateSpace.computeProbeMutualInformation(cand);
      if (mi > bestMi + 1e-12 || (Math.abs(mi - bestMi) <= 1e-12 && cmpStr(cand.itemId, bestProbe.itemId) < 0)) {
        bestProbe = cand;
        bestMi = mi;
      }
    }
    if (this.usedItemIds.size >= this.minItems && this.allChapterQuotasMet() && bestMi <= this.earlyStopMinMutualInfoBits) {
      return stopped("uncertainty_converged");
    }
    this.pendingProbeId = bestProbe.itemId;
    return { status: "selected", probe: bestProbe, mutualInformationBits: bestMi, stopReason: null, administeredCount: this.usedItemIds.size, remainingBudgetSeconds: this.remainingBudgetSeconds };
  }

  recordResponse(observation: DiagnosticProbeObservation): KstObservationUpdateResult & { administeredCount: number; remainingBudgetSeconds: number } {
    const canonicalObsId = observation.observationId.trim();
    if (!canonicalObsId) {
      throw new DiagnosticPlacementError("VALIDATION", "observationId must be non-empty");
    }
    const probe = this.probeById.get(observation.itemId);
    if (!probe) throw new DiagnosticPlacementError("VALIDATION", `Unknown placement probe itemId: ${observation.itemId}`);
    if (this.seenObservationIds.has(canonicalObsId)) {
      return {
        applied: false, reason: "duplicate_observation", observationId: canonicalObsId,
        consumedProbeObservationIds: [...this.stateSpace.consumedProbeObservationIds],
        administeredCount: this.usedItemIds.size, remainingBudgetSeconds: this.remainingBudgetSeconds,
      };
    }
    if (this.stopReason !== null || this.usedItemIds.size >= this.maxItems) {
      throw new DiagnosticPlacementError("INVALID_STATE", "Cannot record response after placement session has stopped or reached maxItems");
    }
    if (this.pendingProbeId !== null && probe.itemId !== this.pendingProbeId) {
      throw new DiagnosticPlacementError("VALIDATION", `Expected response for pending probe ${this.pendingProbeId}, got ${probe.itemId}`);
    }
    if (this.usedItemIds.has(probe.itemId)) {
      throw new DiagnosticPlacementError("VALIDATION", `Probe itemId ${probe.itemId} has already been used in this session`);
    }
    if (this.usedFamilyIds.has(probe.familyId)) {
      throw new DiagnosticPlacementError("VALIDATION", `Probe familyId ${probe.familyId} has already been used in this session`);
    }
    const elapsed = observation.elapsedSeconds ?? probe.estimatedSeconds;
    if (!Number.isFinite(elapsed) || elapsed < 0) throw new DiagnosticPlacementError("VALIDATION", "elapsedSeconds must be finite and >= 0");
    if (elapsed > this.remainingBudgetSeconds + 1e-9) {
      throw new DiagnosticPlacementError("INFEASIBLE", `Probe ${probe.itemId} elapsedSeconds (${elapsed}s) exceeds remaining budget (${this.remainingBudgetSeconds}s)`);
    }
    const mergeCandidateComponents = this.stateSpace.willMergeComponentsForObservation(probe, observation);
    if (this.pendingProbeId === null) {
      if (!this.stateSpace.canEvaluateProbe(probe)) {
        throw new DiagnosticPlacementError("INFEASIBLE", `Probe ${probe.itemId} is infeasible in current KST state space`);
      }
      const nextChapterCount = (this.chapterCounts.get(probe.chapterId) ?? 0) + 1;
      const chapterQuota = this.chapterQuotas.get(probe.chapterId);
      if (chapterQuota && nextChapterCount > chapterQuota.maxItems) {
        throw new DiagnosticPlacementError("VALIDATION", `Chapter ${probe.chapterId} maxItems quota exceeded by probe ${probe.itemId}`);
      }
      if (!this.canCompleteSessionWith(probe, this.remainingBudgetSeconds, elapsed, mergeCandidateComponents)) {
        throw new DiagnosticPlacementError("INFEASIBLE", `Probe ${probe.itemId} leaves remaining session constraints infeasible`);
      }
    } else if (elapsed > probe.estimatedSeconds + 1e-9) {
      if (!this.canCompleteSessionWith(probe, this.remainingBudgetSeconds, elapsed, mergeCandidateComponents)) {
        throw new DiagnosticPlacementError("INFEASIBLE", `Probe ${probe.itemId} actual elapsedSeconds (${elapsed}s) leaves remaining session constraints infeasible`);
      }
    }

    const update = this.stateSpace.applyProbeObservation(probe, observation);
    this.seenObservationIds.add(canonicalObsId);
    this.usedItemIds.add(probe.itemId);
    this.usedFamilyIds.add(probe.familyId);
    this.pendingProbeId = null;

    this.administeredCount = this.usedItemIds.size;
    this.remainingBudgetSeconds = Math.max(0, this.remainingBudgetSeconds - elapsed);
    this.chapterCounts.set(probe.chapterId, (this.chapterCounts.get(probe.chapterId) ?? 0) + 1);
    if (update.applied) this.appliedEvidenceCount += 1;
    if (this.administeredCount >= this.maxItems) this.stopReason = "max_items_reached";
    return { ...update, administeredCount: this.administeredCount, remainingBudgetSeconds: this.remainingBudgetSeconds };
  }

  classifyRoutes(options?: { skipThreshold?: number; readyThreshold?: number; highValueWeightThreshold?: number }): SkillPlacementRoute[] {
    return classifyPlacementRoutes(this.stateSpace, this.skills, { ...this.routeDefaults, ...options });
  }

  buildSnapshot(options?: { snapshotId?: string; courseId?: string; learnerId?: string; createdAtMs?: number }): KstSnapshotV1 {
    return this.stateSpace.buildPriorSnapshot(options);
  }

  getSessionSummary(): {
    administeredCount: number;
    appliedEvidenceCount: number;
    remainingBudgetSeconds: number;
    chapterCounts: Readonly<Record<string, number>>;
    stopReason: PlacementStopReason | null;
    consumedProbeObservationIds: readonly string[];
  } {
    const chapterCounts: Record<string, number> = {};
    for (const [chapterId, count] of this.chapterCounts.entries()) defineRecordEntry(chapterCounts, chapterId, count);
    return {
      administeredCount: this.usedItemIds.size,
      appliedEvidenceCount: this.appliedEvidenceCount,
      remainingBudgetSeconds: this.remainingBudgetSeconds,
      chapterCounts,
      stopReason: this.stopReason,
      consumedProbeObservationIds: [...this.stateSpace.consumedProbeObservationIds],
    };
  }
}
