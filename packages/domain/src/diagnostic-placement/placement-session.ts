import { KstStateSpace, defineRecordEntry, readRecordEntry, validateKstSnapshot, validateProbeItem } from "./kst-state-space";
import {
  DiagnosticPlacementError,
  MAX_EXACT_KST_STATES,
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

  const snapshot = source instanceof KstStateSpace ? source.buildPriorSnapshot() : (validateKstSnapshot(source), source);
  const componentModeBySkill = new Map<string, KstComponentMode>();
  for (const comp of snapshot.componentJointWeights) {
    for (const id of comp.skillIds) {
      if (componentModeBySkill.get(id) === "bounded_component_envelope") continue;
      componentModeBySkill.set(id, comp.approximationMode);
    }
  }
  const hasExplicitComponentModes = snapshot.componentJointWeights.length > 0;

  return skills.map(skill => {
    const pi = readRecordEntry(snapshot.piBySkill, skill.skillId);
    const outerFringe = readRecordEntry(snapshot.outerFringeBySkill, skill.skillId);
    const parentsSatisfied = readRecordEntry(snapshot.parentsSatisfiedBySkill, skill.skillId);
    if (pi === undefined || outerFringe === undefined || parentsSatisfied === undefined) {
      throw new DiagnosticPlacementError("VALIDATION", `Skill ${skill.skillId} missing from KST state`);
    }
    const syllabusWeight = skill.syllabusWeight ?? 0;
    const parents = [...new Set(skill.prerequisiteIds ?? [])].sort(cmpStr);
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

    const exactCertified = hasExplicitComponentModes
      ? [skill.skillId, ...parents].every(id => componentModeBySkill.get(id) === "exact")
      : snapshot.approximationMode === "exact";
    if (exactCertified && parentsSatisfied >= readyThreshold) {
      return { ...base, route: "inferred_ready", uiLabel: READY_UI_LABEL, holdoutVerificationRequired: false, delayedCheckAfterHours: null, missingPrerequisiteIds: [] };
    }
    const weakParents = parents.filter(p => (readRecordEntry(snapshot.piBySkill, p) ?? 0) < readyThreshold);
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

  const fastestByFamilyChapter = new Map<string, DiagnosticProbeItem>();
  const chaptersPerFamily = new Map<string, Set<string>>();
  for (const item of availableItems) {
    if ((deficitsByChapter.get(item.chapterId) ?? 0) === 0 && (headroomByChapter.get(item.chapterId) ?? Infinity) <= 0) continue;
    const key = `${item.familyId}\0${item.chapterId}`;
    const existing = fastestByFamilyChapter.get(key);
    if (!existing || item.estimatedSeconds < existing.estimatedSeconds) fastestByFamilyChapter.set(key, item);
    if (!chaptersPerFamily.has(item.familyId)) chaptersPerFamily.set(item.familyId, new Set());
    chaptersPerFamily.get(item.familyId)!.add(item.chapterId);
  }

  const deduped = [...fastestByFamilyChapter.values()];
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
    if (!Number.isInteger(this.maxItems) || this.maxItems < this.minItems) throw new DiagnosticPlacementError("VALIDATION", "maxItems must be >= minItems");
    if (!Number.isFinite(this.totalBudgetSeconds) || this.totalBudgetSeconds <= 0) throw new DiagnosticPlacementError("VALIDATION", "totalBudgetSeconds must be > 0");
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
    const initKNeeded = Math.max(initTotalDeficit, Math.max(0, this.minItems - (this.usedItemIds.size + 1)));
    if (this.usedItemIds.size + 1 + initKNeeded > this.maxItems) return false;
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
      | { ok: true; groupsCount: number; nextCompToGroup: number[]; nextGroupCounts: bigint[] };

    const evalMerge = (
      item: DiagnosticProbeItem,
      compToGroup: number[],
      groupCounts: bigint[],
    ): MergeOutcome => {
      const origComps = getOrigComps(item);
      if (origComps.length <= 1) {
        return { ok: true, groupsCount: origComps.length, nextCompToGroup: compToGroup, nextGroupCounts: groupCounts };
      }
      const gSet = new Set<number>();
      for (const orig of origComps) gSet.add(compToGroup[orig]!);
      if (gSet.size <= 1) {
        return { ok: true, groupsCount: 1, nextCompToGroup: compToGroup, nextGroupCounts: groupCounts };
      }
      let prod = 1n;
      let targetGroup = Infinity;
      for (const g of gSet) {
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
      return { ok: true, groupsCount: gSet.size, nextCompToGroup, nextGroupCounts };
    };

    const startCompToGroup = Array.from({ length: meta.length }, (_, i) => i);
    const startGroupCounts = meta.map(m => m.stateCount);
    const afterCandidate = evalMerge(candidate, startCompToGroup, startGroupCounts);
    if (!afterCandidate.ok) return false;

    const basePool = this.candidatePool
      .filter(item =>
        item.itemId !== candidate.itemId &&
        item.familyId !== candidate.familyId &&
        !this.usedItemIds.has(item.itemId) &&
        !this.usedFamilyIds.has(item.familyId),
      )
      .sort((a, b) => (a.estimatedSeconds - b.estimatedSeconds) || cmpStr(a.itemId, b.itemId));

    const poolIdxById = new Map(basePool.map((it, idx) => [it.itemId, idx]));
    const pickedFams = new Set<string>();
    const pickedItems = new Set<string>();
    let visitedNodes = 0;
    const MAX_DFS_NODES = 25_000;

    const dfs = (
      usedTotal: number,
      remBudget: number,
      remMinMap: ReadonlyMap<string, number>,
      totalRemMin: number,
      remMaxCapMap: ReadonlyMap<string, number>,
      compToGroup: number[],
      groupCounts: bigint[],
      minIdxByChapter: ReadonlyMap<string, number>,
      caseBStartIdx: number,
    ): boolean => {
      if (++visitedNodes > MAX_DFS_NODES) return false;
      const remNeeded = Math.max(totalRemMin, Math.max(0, this.minItems - usedTotal));
      if (remNeeded === 0) return true;
      if (usedTotal + remNeeded > this.maxItems) return false;

      const allowNonDeficit = totalRemMin < remNeeded;
      const feasible: Array<{ item: DiagnosticProbeItem; outcome: Extract<MergeOutcome, { ok: true }> }> = [];
      let hasMultiGroupCandidate = false;
      for (const item of basePool) {
        if (pickedItems.has(item.itemId) || pickedFams.has(item.familyId)) continue;
        if (item.estimatedSeconds > remBudget + 1e-9) continue;
        if ((remMaxCapMap.get(item.chapterId) ?? Infinity) <= 0) continue;
        if (!allowNonDeficit && (remMinMap.get(item.chapterId) ?? 0) <= 0) continue;
        const outcome = evalMerge(item, compToGroup, groupCounts);
        if (!outcome.ok) continue;
        if (outcome.groupsCount > 1) hasMultiGroupCandidate = true;
        feasible.push({ item, outcome });
      }
      if (feasible.length < remNeeded) return false;

      const headroomNow = new Map<string, number>();
      for (const [ch, cap] of remMaxCapMap.entries()) {
        headroomNow.set(ch, cap === Infinity ? Infinity : Math.max(0, cap - (remMinMap.get(ch) ?? 0)));
      }
      if (!minCostFeasibleCompletion(feasible.map(f => f.item), remMinMap, headroomNow, remNeeded, remBudget)) {
        return false;
      }
      if (!hasMultiGroupCandidate) return true;

      if (totalRemMin > 0) {
        let targetChap: string | null = null;
        let targetCands: typeof feasible = [];
        for (const [ch, def] of remMinMap.entries()) {
          if (def <= 0) continue;
          const minIdx = minIdxByChapter.get(ch) ?? 0;
          const cands = feasible.filter(f => f.item.chapterId === ch && poolIdxById.get(f.item.itemId)! >= minIdx);
          if (cands.length < def) return false;
          if (targetChap === null || cands.length < targetCands.length) {
            targetChap = ch;
            targetCands = cands;
          }
        }
        if (!targetChap) return false;
        targetCands.sort((a, b) =>
          (a.outcome.groupsCount <= 1 ? 0 : 1) - (b.outcome.groupsCount <= 1 ? 0 : 1) ||
          a.item.estimatedSeconds - b.item.estimatedSeconds ||
          cmpStr(a.item.itemId, b.item.itemId),
        );

        for (const { item, outcome } of targetCands) {
          pickedItems.add(item.itemId);
          pickedFams.add(item.familyId);
          const nextMinMap = new Map(remMinMap);
          const curDef = nextMinMap.get(targetChap)!;
          if (curDef <= 1) nextMinMap.delete(targetChap);
          else nextMinMap.set(targetChap, curDef - 1);
          const nextMaxCap = new Map(remMaxCapMap);
          const prevCap = nextMaxCap.get(targetChap) ?? Infinity;
          if (prevCap !== Infinity) nextMaxCap.set(targetChap, prevCap - 1);
          const nextMinIdxMap = new Map(minIdxByChapter);
          nextMinIdxMap.set(targetChap, poolIdxById.get(item.itemId)! + 1);

          const solved = dfs(
            usedTotal + 1,
            remBudget - item.estimatedSeconds,
            nextMinMap,
            totalRemMin - 1,
            nextMaxCap,
            outcome.nextCompToGroup,
            outcome.nextGroupCounts,
            nextMinIdxMap,
            caseBStartIdx,
          );
          pickedItems.delete(item.itemId);
          pickedFams.delete(item.familyId);
          if (solved) return true;
        }
        return false;
      }

      // All chapter minItems satisfied; fill remaining minItems gap cleanly without permutations
      const ordered = feasible
        .filter(f => poolIdxById.get(f.item.itemId)! >= caseBStartIdx)
        .sort((a, b) =>
          (a.outcome.groupsCount <= 1 ? 0 : 1) - (b.outcome.groupsCount <= 1 ? 0 : 1) ||
          a.item.estimatedSeconds - b.item.estimatedSeconds ||
          cmpStr(a.item.itemId, b.item.itemId),
        );
      if (ordered.length < remNeeded) return false;
      for (const { item, outcome } of ordered) {
        const gIdx = poolIdxById.get(item.itemId)!;
        pickedItems.add(item.itemId);
        pickedFams.add(item.familyId);
        const nextMaxCap = new Map(remMaxCapMap);
        const prevCap = nextMaxCap.get(item.chapterId) ?? Infinity;
        if (prevCap !== Infinity) nextMaxCap.set(item.chapterId, prevCap - 1);

        const solved = dfs(
          usedTotal + 1,
          remBudget - item.estimatedSeconds,
          remMinMap,
          0,
          nextMaxCap,
          outcome.nextCompToGroup,
          outcome.nextGroupCounts,
          minIdxByChapter,
          gIdx + 1,
        );
        pickedItems.delete(item.itemId);
        pickedFams.delete(item.familyId);
        if (solved) return true;
      }
      return false;
    };

    return dfs(
      this.usedItemIds.size + 1,
      budgetAfter,
      initRemMin,
      initTotalDeficit,
      initRemMaxCap,
      afterCandidate.nextCompToGroup,
      afterCandidate.nextGroupCounts,
      new Map(),
      0,
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
    if (this.pendingProbeId === null) {
      if (!this.stateSpace.canEvaluateProbe(probe)) {
        throw new DiagnosticPlacementError("INFEASIBLE", `Probe ${probe.itemId} is infeasible in current KST state space`);
      }
      const nextChapterCount = (this.chapterCounts.get(probe.chapterId) ?? 0) + 1;
      const chapterQuota = this.chapterQuotas.get(probe.chapterId);
      if (chapterQuota && nextChapterCount > chapterQuota.maxItems) {
        throw new DiagnosticPlacementError("VALIDATION", `Chapter ${probe.chapterId} maxItems quota exceeded by probe ${probe.itemId}`);
      }
      if (elapsed > this.remainingBudgetSeconds + 1e-9) {
        throw new DiagnosticPlacementError("INFEASIBLE", `Probe ${probe.itemId} elapsedSeconds (${elapsed}s) exceeds remaining budget (${this.remainingBudgetSeconds}s)`);
      }
      if (!this.canCompleteSessionWith(probe, this.remainingBudgetSeconds, elapsed)) {
        throw new DiagnosticPlacementError("INFEASIBLE", `Probe ${probe.itemId} leaves remaining session constraints infeasible`);
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
