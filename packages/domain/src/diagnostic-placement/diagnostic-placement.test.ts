import { describe, expect, it } from "vitest";
import {
  DELAYED_CHECK_AFTER_HOURS,
  DiagnosticPlacementError,
  DiagnosticPlacementSession,
  INTEGRATION_STEP_COORDINATION,
  MAX_EXACT_KST_STATES,
  MAX_TOTAL_DRILLDOWN_PROBES,
  PrerequisiteDrilldownStateMachine,
  SKIP_CANDIDATE_UI_LABEL,
  binaryEntropyBits,
  buildKstPriorSnapshot,
  canonicalStateKey,
  classifyPlacementRoutes,
  createKstStateSpace,
  getSkillCovariance,
  partitionObservationsAgainstKstSnapshot,
  updateSkillMasteryFromKstSnapshot,
  validateKstSnapshot,
  type DiagnosticProbeItem,
  type DiagnosticSkillNode,
} from "./index";

describe("KST state space validation, decomposition & bounded envelope", () => {
  it("fails closed on self-loops, unknown prerequisite references, and cycles", () => {
    expect(() => createKstStateSpace([{ skillId: "A", chapterId: "c1", prerequisiteIds: ["A"] }])).toThrow(DiagnosticPlacementError);
    expect(() => createKstStateSpace([{ skillId: "A", chapterId: "c1", prerequisiteIds: ["MISSING"] }])).toThrow(DiagnosticPlacementError);
    expect(() => createKstStateSpace([
      { skillId: "A", chapterId: "c1", prerequisiteIds: ["B"] },
      { skillId: "B", chapterId: "c1", prerequisiteIds: ["A"] },
    ])).toThrow(DiagnosticPlacementError);
  });

  it("enumerates exact downsets <= 20_000 and decomposes independent components when product > 20_000", () => {
    const chain = createKstStateSpace([
      { skillId: "S1", chapterId: "c1" },
      { skillId: "S2", chapterId: "c1", prerequisiteIds: ["S1"] },
      { skillId: "S3", chapterId: "c1", prerequisiteIds: ["S2"] },
    ]);
    expect(chain.approximationMode).toBe("exact");
    expect(chain.totalFeasibleStateCount).toBe(4);

    // 15 independent skills => 2^15 = 32_768 > 20_000; each component has 2 exact states.
    const independent15 = Array.from({ length: 15 }, (_, i) => ({ skillId: `I_${i}`, chapterId: "c1" }));
    const decomposed = createKstStateSpace(independent15);
    expect(decomposed.approximationMode).toBe("component_decomposed");
    expect(decomposed.totalFeasibleStateCount).toBe(32_768);
    expect(decomposed.components).toHaveLength(15);
    expect(decomposed.components.every(c => c.approximationMode === "exact" && c.states.length === 2)).toBe(true);
  });

  it("uses bounded_component_envelope without freezing when a single connected component exceeds 20_000 states", () => {
    const starSkills: DiagnosticSkillNode[] = [
      { skillId: "ROOT", chapterId: "c1" },
      ...Array.from({ length: 16 }, (_, i) => ({ skillId: `LEAF_${String(i).padStart(2, "0")}`, chapterId: "c1", prerequisiteIds: ["ROOT"] })),
    ];
    const space = createKstStateSpace(starSkills);
    expect(space.approximationMode).toBe("bounded_component_envelope");
    expect(space.totalFeasibleStateCount).toBeNull();
    expect(space.components[0]!.states.length).toBeLessThanOrEqual(MAX_EXACT_KST_STATES);

    const snap = buildKstPriorSnapshot(space);
    for (const s of starSkills) {
      expect(snap.piBySkill[s.skillId]!).toBeGreaterThan(0);
      expect(snap.piBySkill[s.skillId]!).toBeLessThan(1);
    }
    expect(snap.outerFringeBySkill["LEAF_00"]!).toBeGreaterThan(0);

    const probe: DiagnosticProbeItem = { itemId: "p-leaf-0", familyId: "f-leaf-0", chapterId: "c1", requiredSkillIds: ["LEAF_00"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 };
    space.applyProbeObservation(probe, { observationId: "obs-star-1", itemId: "p-leaf-0", correct: true });
    const after = buildKstPriorSnapshot(space);
    expect(after.piBySkill["LEAF_00"]!).toBeGreaterThan(snap.piBySkill["LEAF_00"]!);
    expect(after.piBySkill["ROOT"]!).toBeGreaterThan(snap.piBySkill["ROOT"]!);
  });
});

describe("KST Bayesian updates, idempotency, and Axiom C1 anti-double-counting", () => {
  it("yields exact 0.900 (never 0.988) on a 9:1 LR probe, strips consumed observations, and is idempotent", () => {
    const space = createKstStateSpace([{ skillId: "A", chapterId: "c1" }]);
    const probe: DiagnosticProbeItem = { itemId: "q1", familyId: "fam-1", chapterId: "c1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 30 };

    expect(space.applyProbeObservation(probe, { observationId: "obs-hint", itemId: "q1", correct: true, channel: "hinted" }).applied).toBe(false);
    expect(space.getSkillMarginals()["A"]).toBeCloseTo(0.5, 12);

    expect(space.applyProbeObservation(probe, { observationId: "obs-9to1", itemId: "q1", correct: true }).applied).toBe(true);
    expect(space.getSkillMarginals()["A"]).toBeCloseTo(0.9, 12);

    const replay = space.applyProbeObservation(probe, { observationId: "obs-9to1", itemId: "q1", correct: true });
    expect(replay.applied).toBe(false);
    expect(replay.reason).toBe("duplicate_observation");
    expect(space.getSkillMarginals()["A"]).toBeCloseTo(0.9, 12);

    const snapshot = buildKstPriorSnapshot(space, { snapshotId: "snap-c1", createdAtMs: 1_000 });
    expect(snapshot.consumedProbeObservationIds).toEqual(["obs-9to1"]);
    expect(snapshot.wByState?.[canonicalStateKey(["A"])]).toBeCloseTo(0.9, 12);
    expect(getSkillCovariance(snapshot, "A", "A")).toBeCloseTo(0.09, 12);

    const partitioned = partitionObservationsAgainstKstSnapshot(snapshot, [{ observationId: "obs-9to1", skillId: "A", correct: true, slip: 0.1, guess: 0.1 }]);
    expect(partitioned.directObservations).toEqual([]);
    expect(partitioned.strippedConsumedObservations[0]!.eligibleForFirePropagation).toBe(false);

    const downstream = updateSkillMasteryFromKstSnapshot(
      snapshot,
      "A",
      [{ observationId: "obs-9to1", skillId: "A", correct: true, slip: 0.1, guess: 0.1 }],
      { workspaceId: "ws-1", learnerId: "l-1", courseId: "c-1", confirmedSkillVersion: 1 },
    );
    expect(downstream.posteriorProbability).toBeCloseTo(0.9, 12);
    expect(downstream.posteriorProbability).not.toBeCloseTo(81 / 82, 2);

    const freshDownstream = updateSkillMasteryFromKstSnapshot(snapshot, "A", [
      { observationId: "obs-9to1", skillId: "A", correct: true, slip: 0.1, guess: 0.1 },
      { observationId: "obs-fresh-2", skillId: "A", correct: true, slip: 0.1, guess: 0.1 },
    ]);
    expect(freshDownstream.partitioned.directObservations.map(o => o.observationId)).toEqual(["obs-fresh-2"]);
    expect(freshDownstream.partitioned.annotatedObservations[1]!.eligibleForFirePropagation).toBe(true);
    expect(freshDownstream.posteriorProbability).toBeCloseTo(81 / 82, 12);
  });

  it("handles 200 extreme updates in log space without underflow", () => {
    const space = createKstStateSpace([{ skillId: "X", chapterId: "c1" }]);
    const probe: DiagnosticProbeItem = { itemId: "qx", familyId: "fx", chapterId: "c1", requiredSkillIds: ["X"], slip: 0.01, guess: 0.01, estimatedSeconds: 10 };
    for (let i = 0; i < 200; i++) space.applyProbeObservation(probe, { observationId: `x-${i}`, itemId: "qx", correct: true });
    const snap = buildKstPriorSnapshot(space);
    expect(Number.isFinite(snap.piBySkill["X"])).toBe(true);
    expect(snap.piBySkill["X"]).toBeCloseTo(1, 10);
  });
});

describe("Shadow-CAT 6-10 item MI placement & honest route classification", () => {
  it("maximizes Shannon MI subject to Shadow-CAT time/chapter feasibility and honest 3-state skip flags", () => {
    const skills: DiagnosticSkillNode[] = [
      { skillId: "A1", chapterId: "ch1", syllabusWeight: 0.25 },
      { skillId: "A2", chapterId: "ch1", prerequisiteIds: ["A1"], syllabusWeight: 0.1 },
      { skillId: "B1", chapterId: "ch2", syllabusWeight: 0.3 },
      { skillId: "B2", chapterId: "ch2", prerequisiteIds: ["B1"], syllabusWeight: 0.15 },
      { skillId: "C1", chapterId: "ch3", syllabusWeight: 0.2 },
    ];
    const space = createKstStateSpace(skills);
    const probeA1: DiagnosticProbeItem = { itemId: "item-a1", familyId: "fam-a1", chapterId: "ch1", requiredSkillIds: ["A1"], slip: 0.1, guess: 0.1, estimatedSeconds: 40 };
    const pA1 = space.getSkillMarginals()["A1"]!;
    const expectedMi = binaryEntropyBits(pA1 * 0.9 + (1 - pA1) * 0.1) - (pA1 * binaryEntropyBits(0.9) + (1 - pA1) * binaryEntropyBits(0.1));
    expect(space.computeProbeMutualInformation(probeA1)).toBeCloseTo(expectedMi, 12);

    const candidatePool: DiagnosticProbeItem[] = [
      { ...probeA1, itemId: "item-a1-slow", estimatedSeconds: 190 },
      probeA1,
      { ...probeA1, itemId: "item-a1-clone-same-fam", estimatedSeconds: 20 },
      { itemId: "item-a2", familyId: "fam-a2", chapterId: "ch1", requiredSkillIds: ["A2"], slip: 0.1, guess: 0.1, estimatedSeconds: 30 },
      { itemId: "item-b1", familyId: "fam-b1", chapterId: "ch2", requiredSkillIds: ["B1"], slip: 0.1, guess: 0.1, estimatedSeconds: 40 },
      { itemId: "item-b2", familyId: "fam-b2", chapterId: "ch2", requiredSkillIds: ["B2"], slip: 0.1, guess: 0.1, estimatedSeconds: 40 },
      { itemId: "item-c1-1", familyId: "fam-c1-1", chapterId: "ch3", requiredSkillIds: ["C1"], slip: 0.1, guess: 0.1, estimatedSeconds: 40 },
      { itemId: "item-c1-2", familyId: "fam-c1-2", chapterId: "ch3", requiredSkillIds: ["C1"], slip: 0.1, guess: 0.1, estimatedSeconds: 40 },
      { itemId: "item-c1-3", familyId: "fam-c1-3", chapterId: "ch1", requiredSkillIds: ["A1", "B1"], slip: 0.1, guess: 0.1, estimatedSeconds: 30 },
      { itemId: "item-c1-4", familyId: "fam-c2-4", chapterId: "ch2", requiredSkillIds: ["B1", "C1"], slip: 0.1, guess: 0.1, estimatedSeconds: 30 },
    ];

    const session = new DiagnosticPlacementSession({
      skills,
      candidatePool,
      config: { minItems: 6, maxItems: 10, totalBudgetSeconds: 300, chapterQuotas: { ch1: 2, ch2: 2, ch3: 2 } },
    });

    const selectedItems: string[] = [];
    const selectedFamilies = new Set<string>();
    for (let step = 0; step < 10; step++) {
      const next = session.selectNextProbe();
      if (next.status === "stopped" || !next.probe) break;
      expect(next.probe.itemId).not.toBe("item-a1-slow");
      expect(selectedFamilies.has(next.probe.familyId)).toBe(false);
      selectedItems.push(next.probe.itemId);
      selectedFamilies.add(next.probe.familyId);
      session.recordResponse({ observationId: `sess-obs-${step}`, itemId: next.probe.itemId, correct: true });
    }

    const summary = session.getSessionSummary();
    expect(selectedItems.length).toBeGreaterThanOrEqual(6);
    expect(selectedItems.length).toBeLessThanOrEqual(10);
    expect(summary.chapterCounts["ch1"]).toBeGreaterThanOrEqual(2);
    expect(summary.chapterCounts["ch2"]).toBeGreaterThanOrEqual(2);
    expect(summary.chapterCounts["ch3"]).toBeGreaterThanOrEqual(2);

    const routes = session.classifyRoutes();
    const b1 = routes.find(r => r.skillId === "B1")!;
    expect(b1.route).toBe("inferred_skip_candidate");
    expect(b1.countsTowardMastery).toBe(false);
    expect(b1.uiLabel).toBe(SKIP_CANDIDATE_UI_LABEL);
    expect(b1.holdoutVerificationRequired).toBe(true);
    expect(b1.delayedCheckAfterHours).toBe(DELAYED_CHECK_AFTER_HOURS);

    const a2 = routes.find(r => r.skillId === "A2")!;
    if (a2.route === "inferred_skip_candidate") {
      expect(a2.countsTowardMastery).toBe(false);
      expect(a2.holdoutVerificationRequired).toBe(false);
      expect(a2.delayedCheckAfterHours).toBeNull();
    }
  });

  it("computes exact joint outer fringe and rejects naive marginal parent product (w({A})=0.5, w({B})=0.5)", () => {
    const skills: DiagnosticSkillNode[] = [
      { skillId: "A", chapterId: "c1" },
      { skillId: "B", chapterId: "c1" },
      { skillId: "C", chapterId: "c1", prerequisiteIds: ["A", "B"] },
    ];
    const synthetic = {
      ...buildKstPriorSnapshot(createKstStateSpace(skills)),
      wByState: { [canonicalStateKey([])]: 0, [canonicalStateKey(["A"])]: 0.5, [canonicalStateKey(["B"])]: 0.5, [canonicalStateKey(["A", "B"])]: 0, [canonicalStateKey(["A", "B", "C"])]: 0 },
      piBySkill: { A: 0.5, B: 0.5, C: 0 },
      outerFringeBySkill: { A: 0.5, B: 0.5, C: 0 },
      parentsSatisfiedBySkill: { A: 1, B: 1, C: 0 },
    };

    const routes = classifyPlacementRoutes(synthetic, skills, { readyThreshold: 0.2 });
    const cRoute = routes.find(r => r.skillId === "C")!;
    expect(cRoute.outerFringeProbability).toBe(0);
    expect(cRoute.parentsSatisfiedProbability).toBe(0);
    expect(cRoute.route).toBe("prerequisite_gap_blocked");
    expect(cRoute.missingPrerequisiteIds).toEqual(["A", "B"]);

    const space = createKstStateSpace(skills);
    space.applyProbeObservation(
      { itemId: "q-ab", familyId: "f-ab", chapterId: "c1", requiredSkillIds: ["A", "B"], slip: 0.01, guess: 0.01, estimatedSeconds: 30 },
      { observationId: "obs-ab-fail", itemId: "q-ab", correct: false },
    );
    const snap = buildKstPriorSnapshot(space);
    expect(snap.parentsSatisfiedBySkill["C"]!).toBeLessThan(snap.piBySkill["A"]! * snap.piBySkill["B"]!);
    expect(getSkillCovariance(snap, "A", "B")).toBeLessThan(0);
  });
});

describe("Hard-capped 2-probe PrerequisiteDrilldownStateMachine", () => {
  const chainSkills: DiagnosticSkillNode[] = [
    { skillId: "L0", chapterId: "c1" },
    { skillId: "L1", chapterId: "c1", prerequisiteIds: ["L0"] },
    { skillId: "L2", chapterId: "c1", prerequisiteIds: ["L1"] },
    { skillId: "L3", chapterId: "c1", prerequisiteIds: ["L2"] },
    { skillId: "TARGET", chapterId: "c1", prerequisiteIds: ["L3"] },
  ];
  const chainProbes: DiagnosticProbeItem[] = [
    { itemId: "p-l0", familyId: "f-l0", chapterId: "c1", requiredSkillIds: ["L0"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 },
    { itemId: "p-l1", familyId: "f-l1", chapterId: "c1", requiredSkillIds: ["L1"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 },
    { itemId: "p-l2", familyId: "f-l2", chapterId: "c1", requiredSkillIds: ["L2"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 },
    { itemId: "p-l3", familyId: "f-l3", chapterId: "c1", requiredSkillIds: ["L3"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 },
  ];
  const originalContext = { originalAttemptId: "attempt-99", originalItemId: "item-target-1", frozenDraftText: "let x = 2 * (a + b) - ", frozenCursorOffset: 22, startedAtMs: 1_700_000_000_000 };

  it("clamps maxProbes > 2 to 2 total across a 4-layer chain and builds bottom-up repair plan", () => {
    const machine = new PrerequisiteDrilldownStateMachine({ skills: chainSkills, targetSkillId: "TARGET", probePool: chainProbes, originalContext, maxProbes: 8 });
    expect(machine.maxTotalProbes).toBe(MAX_TOTAL_DRILLDOWN_PROBES);

    const sel1 = machine.selectNextProbe();
    expect(["p-l1", "p-l2"]).toContain(sel1.probe!.itemId);
    machine.recordProbeResponse({ observationId: "dd-1", itemId: sel1.probe!.itemId, correct: false });

    const sel2 = machine.selectNextProbe();
    const finalState = machine.recordProbeResponse({ observationId: "dd-2", itemId: sel2.probe!.itemId, correct: true });
    expect(finalState.probesAdministered).toBe(2);
    expect(finalState.status).toBe("repair_plan_ready");
    expect(finalState.rootCause).toBe("prerequisite_deficit");
    expect(finalState.repairPlan[0]!.kind).toBe("foundational_prerequisite");
    expect(finalState.repairPlan.some(step => step.kind === "bridging_step")).toBe(true);
    expect(finalState.repairPlan.at(-1)!.kind).toBe("restore_original_attempt");

    expect(() => machine.recordProbeResponse({ observationId: "dd-3", itemId: "p-l3", correct: false })).toThrow(DiagnosticPlacementError);
    const restored = machine.restoreOriginalAttempt();
    expect(restored).toEqual(originalContext);
    expect(Object.isFrozen(restored)).toBe(true);
  });

  it("classifies integration_step_coordination only when all probes (1 or 2) pass unassisted, preserving frozen context", () => {
    const machine = new PrerequisiteDrilldownStateMachine({ skills: chainSkills, targetSkillId: "TARGET", probePool: chainProbes, originalContext });
    const sel1 = machine.selectNextProbe();
    machine.recordProbeResponse({ observationId: "pass-1", itemId: sel1.probe!.itemId, correct: true });
    const sel2 = machine.selectNextProbe();
    const state = machine.recordProbeResponse({ observationId: "pass-2", itemId: sel2.probe!.itemId, correct: true });

    expect(state.probesAdministered).toBe(2);
    expect(state.status).toBe("restore_original_attempt");
    expect(state.rootCause).toBe(INTEGRATION_STEP_COORDINATION);
    expect(state.restoreContext).toEqual(originalContext);

    const single = new PrerequisiteDrilldownStateMachine({ skills: chainSkills, targetSkillId: "TARGET", probePool: chainProbes, originalContext, maxProbes: 1 });
    const one = single.selectNextProbe();
    const oneDone = single.recordProbeResponse({ observationId: "one-pass", itemId: one.probe!.itemId, correct: true });
    expect(oneDone.probesAdministered).toBe(1);
    expect(oneDone.status).toBe("restore_original_attempt");
    expect(oneDone.rootCause).toBe(INTEGRATION_STEP_COORDINATION);
    expect(oneDone.restoreContext).toEqual(originalContext);

    // Assisted-only probes have zero unassisted diagnostic evidence -> honest insufficient_diagnostic_evidence restore
    const assisted = new PrerequisiteDrilldownStateMachine({ skills: chainSkills, targetSkillId: "TARGET", probePool: chainProbes, originalContext, maxProbes: 1 });
    const aSel = assisted.selectNextProbe();
    const aDone = assisted.recordProbeResponse({ observationId: "a-pass", itemId: aSel.probe!.itemId, correct: true, channel: "assisted" });
    expect(aDone.status).toBe("restore_original_attempt");
    expect(aDone.rootCause).toBe("insufficient_diagnostic_evidence");
    expect(aDone.confirmedDeficitSkillIds).toEqual([]);
    expect(aDone.repairPlan.map(s => s.kind)).toEqual(["restore_original_attempt"]);
  });
});

describe("Round-2 correctness, anti-double-counting & fail-closed regression checks", () => {
  it("[P0-1] couples cross-component joint posteriors via exact Cartesian merge, hits 1/3 floor, and rejects >20_000 or bounded merges", () => {
    // 1) 15 independent skills => component_decomposed (32_768 states)
    const independent15: DiagnosticSkillNode[] = Array.from({ length: 15 }, (_, i) => ({ skillId: `I_${i}`, chapterId: "c1" }));
    const space = createKstStateSpace(independent15);
    expect(space.components).toHaveLength(15);

    const qBoth: DiagnosticProbeItem = { itemId: "q-i0-i1", familyId: "f-both", chapterId: "c1", requiredSkillIds: ["I_0", "I_1"], slip: 0.01, guess: 0.01, estimatedSeconds: 30 };
    const qSingle0: DiagnosticProbeItem = { itemId: "q-i0", familyId: "f-i0", chapterId: "c1", requiredSkillIds: ["I_0"], slip: 0.01, guess: 0.01, estimatedSeconds: 20 };

    // Apply q1(["I_0", "I_1"]) = false then q2(["I_0"]) = true -> exact explaining-away gives pi(I_1) = 1/51
    const r1 = space.applyProbeObservation(qBoth, { observationId: "cross-1", itemId: "q-i0-i1", correct: false });
    expect(r1.applied).toBe(true);
    expect(space.components).toHaveLength(14);
    expect(getSkillCovariance(buildKstPriorSnapshot(space), "I_0", "I_1")).toBeLessThan(0);

    const r2 = space.applyProbeObservation(qSingle0, { observationId: "cross-2", itemId: "q-i0", correct: true });
    expect(r2.applied).toBe(true);
    const snapAfter = buildKstPriorSnapshot(space);
    expect(snapAfter.piBySkill["I_1"]).toBeCloseTo(1 / 51, 12);
    expect(getSkillCovariance(snapAfter, "I_0", "I_1")).toBeLessThan(0);

    // 2) Conjunctive failures with s=0, g=0 hit exact 1/3 Bayes floor, and zero-likelihood cross-component merge does not mutate components
    const zeroSpace = createKstStateSpace(independent15);
    const qDet: DiagnosticProbeItem = { itemId: "q-det", familyId: "f-det", chapterId: "c1", requiredSkillIds: ["I_0", "I_1"], slip: 0, guess: 0, estimatedSeconds: 20 };
    expect(zeroSpace.applyProbeObservation(qDet, { observationId: "det-1", itemId: "q-det", correct: false }).applied).toBe(true);
    expect(zeroSpace.applyProbeObservation(qDet, { observationId: "det-2", itemId: "q-det", correct: false }).applied).toBe(true);
    expect(zeroSpace.getSkillMarginals()["I_0"]).toBeCloseTo(1 / 3, 12);
    expect(zeroSpace.getSkillMarginals()["I_1"]).toBeCloseTo(1 / 3, 12);

    const qDetSingle2: DiagnosticProbeItem = { itemId: "q-i2-det", familyId: "f-i2", chapterId: "c1", requiredSkillIds: ["I_2"], slip: 0, guess: 0, estimatedSeconds: 20 };
    const qDetPair23: DiagnosticProbeItem = { itemId: "q-i2-i3-det", familyId: "f-23", chapterId: "c1", requiredSkillIds: ["I_2", "I_3"], slip: 0, guess: 0, estimatedSeconds: 20 };
    expect(zeroSpace.applyProbeObservation(qDetSingle2, { observationId: "det-i2-fail", itemId: "q-i2-det", correct: false }).applied).toBe(true);
    const compCountBeforeZero = zeroSpace.components.length;
    const zeroMerge = zeroSpace.applyProbeObservation(qDetPair23, { observationId: "det-23-imp", itemId: "q-i2-i3-det", correct: true });
    expect(zeroMerge.applied).toBe(false);
    expect(zeroMerge.reason).toBe("zero_likelihood_observation");
    expect(zeroSpace.components).toHaveLength(compCountBeforeZero);

    // 3) Cross-component merge exceeding 20_000 states (two 150-skill chains => 151 * 151 = 22_801 > 20_000) fails closed and session skips it
    const makeChain = (prefix: string, len: number): DiagnosticSkillNode[] =>
      Array.from({ length: len }, (_, i) => ({
        skillId: `${prefix}_${i}`,
        chapterId: "c1",
        ...(i > 0 ? { prerequisiteIds: [`${prefix}_${i - 1}`] } : {}),
      }));
    const bigChains = [...makeChain("A", 150), ...makeChain("B", 150)];
    const bigSpace = createKstStateSpace(bigChains);
    expect(bigSpace.totalFeasibleStateCount).toBe(22_801);
    const crossTooBig: DiagnosticProbeItem = { itemId: "cross-big", familyId: "f-big", chapterId: "c1", requiredSkillIds: ["A_149", "B_149"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 };
    expect(() => bigSpace.computeProbeMutualInformation(crossTooBig)).toThrow(DiagnosticPlacementError);
    expect(() => bigSpace.applyProbeObservation(crossTooBig, { observationId: "big-1", itemId: "cross-big", correct: true })).toThrow(DiagnosticPlacementError);

    // 4) Cross-component probe touching a bounded_component_envelope fails closed with INFEASIBLE
    const boundedPlusSolo: DiagnosticSkillNode[] = [
      { skillId: "ROOT", chapterId: "c1" },
      ...Array.from({ length: 16 }, (_, i) => ({ skillId: `LEAF_${i}`, chapterId: "c1", prerequisiteIds: ["ROOT"] })),
      { skillId: "SOLO", chapterId: "c1" },
    ];
    const boundedSpace = createKstStateSpace(boundedPlusSolo);
    const crossBounded: DiagnosticProbeItem = { itemId: "cross-bnd", familyId: "f-bnd", chapterId: "c1", requiredSkillIds: ["LEAF_0", "SOLO"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 };
    try {
      boundedSpace.computeProbeMutualInformation(crossBounded);
      expect.unreachable("should throw INFEASIBLE");
    } catch (err) {
      expect(err).toBeInstanceOf(DiagnosticPlacementError);
      expect((err as DiagnosticPlacementError).code).toBe("INFEASIBLE");
    }

    const session = new DiagnosticPlacementSession({
      skills: bigChains,
      candidatePool: [
        crossTooBig,
        { itemId: "safe-a", familyId: "f-sa", chapterId: "c1", requiredSkillIds: ["A_0"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 },
      ],
      config: { minItems: 1, maxItems: 2, totalBudgetSeconds: 100 },
    });
    const picked = session.selectNextProbe();
    expect(picked.status).toBe("selected");
    expect(picked.probe?.itemId).toBe("safe-a");
  });

  it("[P1-1] computes exact BigInt totalFeasibleStateCount for 16 and 20 independent skills without 20_000 truncation", () => {
    const ind16 = createKstStateSpace(Array.from({ length: 16 }, (_, i) => ({ skillId: `S_${i}`, chapterId: "c1" })));
    expect(ind16.approximationMode).toBe("component_decomposed");
    expect(ind16.totalFeasibleStateCount).toBe(65_536);

    const ind20 = createKstStateSpace(Array.from({ length: 20 }, (_, i) => ({ skillId: `T_${i}`, chapterId: "c1" })));
    expect(ind20.approximationMode).toBe("component_decomposed");
    expect(ind20.totalFeasibleStateCount).toBe(1_048_576);
  });

  it("[P1-2] enforces atomic recordResponse validation, INVALID_STATE after stop/maxItems, idempotent replay, and pendingProbeId reset", () => {
    const skills: DiagnosticSkillNode[] = [
      { skillId: "A", chapterId: "c1" },
      { skillId: "B", chapterId: "c1" },
    ];
    const pool: DiagnosticProbeItem[] = [
      { itemId: "p1", familyId: "f1", chapterId: "c1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 },
      { itemId: "p2", familyId: "f2", chapterId: "c1", requiredSkillIds: ["B"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 },
    ];
    const session = new DiagnosticPlacementSession({ skills, candidatePool: pool, config: { minItems: 1, maxItems: 1, totalBudgetSeconds: 100 } });

    const sel1 = session.selectNextProbe();
    expect(sel1.probe?.itemId).toBe("p1");

    // Blank observationId fails VALIDATION before mutating item/budget state
    expect(() => session.recordResponse({ observationId: "   ", itemId: "p1", correct: true })).toThrow(DiagnosticPlacementError);
    expect(session.getSessionSummary().remainingBudgetSeconds).toBe(100);
    expect(session.selectNextProbe().probe?.itemId).toBe("p1");

    // While p1 is pending, submitting a different item p2 fails VALIDATION without mutating state
    expect(() => session.recordResponse({ observationId: "obs-mismatch", itemId: "p2", correct: true })).toThrow(DiagnosticPlacementError);
    expect(session.selectNextProbe().probe?.itemId).toBe("p1");

    // Valid response for pending p1 clears pendingProbeId and reaches maxItems
    const rec = session.recordResponse({ observationId: "obs-p1", itemId: "p1", correct: true });
    expect(rec.applied).toBe(true);
    expect(session.getSessionSummary().stopReason).toBe("max_items_reached");

    // Replay remains idempotent after stop
    const replay = session.recordResponse({ observationId: "obs-p1", itemId: "p1", correct: true });
    expect(replay.applied).toBe(false);
    expect(replay.reason).toBe("duplicate_observation");

    // Fresh observation after stop/maxItems fails closed with INVALID_STATE
    try {
      session.recordResponse({ observationId: "obs-after-stop", itemId: "p2", correct: true });
      expect.unreachable("should throw INVALID_STATE");
    } catch (err) {
      expect(err).toBeInstanceOf(DiagnosticPlacementError);
      expect((err as DiagnosticPlacementError).code).toBe("INVALID_STATE");
    }
  });

  it("[P1-3 & P2-3] deduplicates within a batch and blocks unassisted/blank IDs from direct update & FIRE propagation", () => {
    const space = createKstStateSpace([{ skillId: "A", chapterId: "c1" }]);
    const snap = buildKstPriorSnapshot(space);
    const batch = [
      { observationId: "obs-2", skillId: "A", correct: true, slip: 0.1, guess: 0.1 },
      { observationId: "obs-2", skillId: "A", correct: true, slip: 0.1, guess: 0.1 },
      { observationId: "obs-hint", skillId: "A", correct: true, slip: 0.1, guess: 0.1, channel: "hinted" as const },
      { observationId: "   ", skillId: "A", correct: true, slip: 0.1, guess: 0.1 },
    ];
    const part = partitionObservationsAgainstKstSnapshot(snap, batch);
    expect(part.unconsumedObservations.map(o => o.observationId)).toEqual(["obs-2"]);
    expect(part.directObservations.map(o => o.observationId)).toEqual(["obs-2"]);
    expect(part.annotatedObservations[0]!.eligibleForDirectUpdate).toBe(true);
    expect(part.annotatedObservations[0]!.eligibleForFirePropagation).toBe(true);
    expect(part.annotatedObservations[1]!.eligibleForDirectUpdate).toBe(false);
    expect(part.annotatedObservations[1]!.eligibleForFirePropagation).toBe(false);
    expect(part.annotatedObservations[2]!.eligibleForDirectUpdate).toBe(false);
    expect(part.annotatedObservations[2]!.eligibleForFirePropagation).toBe(false);
    expect(part.annotatedObservations[3]!.eligibleForDirectUpdate).toBe(false);
    expect(part.annotatedObservations[3]!.eligibleForFirePropagation).toBe(false);

    const res = updateSkillMasteryFromKstSnapshot(snap, "A", batch);
    expect(res.appliedObservationIds).toEqual(["obs-2"]);
    expect(res.posteriorProbability).toBeCloseTo(0.9, 12);
  });

  it("[P1-4] excludes non-prerequisite probes in drilldown, rejects invalid direct submissions & repeats, and clears pendingProbeId", () => {
    const skills: DiagnosticSkillNode[] = [
      { skillId: "P0", chapterId: "c1" },
      { skillId: "P1", chapterId: "c1", prerequisiteIds: ["P0"] },
      { skillId: "TARGET", chapterId: "c1", prerequisiteIds: ["P1"] },
      { skillId: "UNRELATED", chapterId: "c2" },
    ];
    const probes: DiagnosticProbeItem[] = [
      { itemId: "p-unrelated", familyId: "f-unrel", chapterId: "c2", requiredSkillIds: ["UNRELATED"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 },
      { itemId: "p-target", familyId: "f-tgt", chapterId: "c1", requiredSkillIds: ["TARGET"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 },
      { itemId: "p-p0", familyId: "f-p0", chapterId: "c1", requiredSkillIds: ["P0"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 },
      { itemId: "p-p1", familyId: "f-shared", chapterId: "c1", requiredSkillIds: ["P1"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 },
      { itemId: "p-p1-clone", familyId: "f-shared", chapterId: "c1", requiredSkillIds: ["P1"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 },
    ];
    const machine = new PrerequisiteDrilldownStateMachine({
      skills,
      targetSkillId: "TARGET",
      probePool: probes,
      originalContext: { originalAttemptId: "att-1", originalItemId: "tgt-item", frozenDraftText: "draft", frozenCursorOffset: 0, startedAtMs: 10 },
    });

    expect(() => machine.recordProbeResponse({ observationId: "bad-unrel", itemId: "p-unrelated", correct: true })).toThrow(DiagnosticPlacementError);
    expect(() => machine.recordProbeResponse({ observationId: "bad-tgt", itemId: "p-target", correct: true })).toThrow(DiagnosticPlacementError);

    const sel1 = machine.selectNextProbe();
    expect(["p-p0", "p-p1", "p-p1-clone"]).toContain(sel1.probe?.itemId);
    // Record response on p-p0 even if p-p1 was pending; then verify family/item reuse is rejected and pendingProbeId cleared
    machine.recordProbeResponse({ observationId: "dd-ok-1", itemId: "p-p0", correct: false });
    expect(() => machine.recordProbeResponse({ observationId: "dd-dup-item", itemId: "p-p0", correct: true })).toThrow(DiagnosticPlacementError);

    const sel2 = machine.selectNextProbe();
    expect(["p-p1", "p-p1-clone"]).toContain(sel2.probe?.itemId);
    machine.recordProbeResponse({ observationId: "dd-ok-2", itemId: "p-p1", correct: true });
    try {
      machine.recordProbeResponse({ observationId: "dd-after-cap", itemId: "p-p1-clone", correct: true });
      expect.unreachable("should throw INVALID_STATE");
    } catch (err) {
      expect(err).toBeInstanceOf(DiagnosticPlacementError);
      expect((err as DiagnosticPlacementError).code).toBe("INVALID_STATE");
    }
  });

  it("[P2-1 & P2-2] validates external snapshots/configs/drilldown MI and distinguishes candidate_pool_exhausted from time_budget_exhausted", () => {
    const skills: DiagnosticSkillNode[] = [
      { skillId: "A", chapterId: "ch1" },
      { skillId: "B", chapterId: "ch2" },
    ];
    const snap = buildKstPriorSnapshot(createKstStateSpace(skills));
    expect(() => validateKstSnapshot({ ...snap, piBySkill: { ...snap.piBySkill, A: Number.NaN } })).toThrow(DiagnosticPlacementError);
    expect(() => classifyPlacementRoutes({ ...snap, piBySkill: { ...snap.piBySkill, A: 1.5 } }, skills)).toThrow(DiagnosticPlacementError);

    expect(() => new DiagnosticPlacementSession({
      skills,
      candidatePool: [{ itemId: "pa", familyId: "fa", chapterId: "ch1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 }],
      config: { minItems: 1, maxItems: 1, earlyStopMinMutualInfoBits: -0.01 },
    })).toThrow(DiagnosticPlacementError);

    const dd = new PrerequisiteDrilldownStateMachine({
      skills: [{ skillId: "A", chapterId: "ch1" }, { skillId: "T", chapterId: "ch1", prerequisiteIds: ["A"] }],
      targetSkillId: "T",
      probePool: [{ itemId: "pa", familyId: "fa", chapterId: "ch1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 }],
      originalContext: { originalAttemptId: "a1", originalItemId: "i1", frozenDraftText: "", frozenCursorOffset: 0, startedAtMs: 1 },
    });
    expect(() => dd.computeProbeMutualInformation({ itemId: "bad-mi", familyId: "fb", chapterId: "ch1", requiredSkillIds: ["A"], slip: 0.6, guess: 0.1, estimatedSeconds: 20 })).toThrow(DiagnosticPlacementError);

    // Chapter maxItems exhausts legal candidates despite 270s remaining budget -> candidate_pool_exhausted (not time_budget_exhausted)
    const chapterCapSession = new DiagnosticPlacementSession({
      skills,
      candidatePool: [
        { itemId: "c1-1", familyId: "f1", chapterId: "ch1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 30 },
        { itemId: "c1-2", familyId: "f2", chapterId: "ch1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 30 },
      ],
      config: { minItems: 1, maxItems: 3, totalBudgetSeconds: 300, chapterQuotas: { ch1: { minItems: 0, maxItems: 1 } } },
    });
    const pick = chapterCapSession.selectNextProbe();
    expect(pick.status).toBe("selected");
    chapterCapSession.recordResponse({ observationId: "cc-1", itemId: pick.probe!.itemId, correct: true });
    const stoppedByQuota = chapterCapSession.selectNextProbe();
    expect(stoppedByQuota.status).toBe("stopped");
    expect(stoppedByQuota.stopReason).toBe("candidate_pool_exhausted");

    // Time shortfall with chapter/family-feasible candidates under Infinity -> time_budget_exhausted
    const timeSession = new DiagnosticPlacementSession({
      skills,
      candidatePool: [
        { itemId: "t-1", familyId: "ft1", chapterId: "ch1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 30 },
        { itemId: "t-2", familyId: "ft2", chapterId: "ch2", requiredSkillIds: ["B"], slip: 0.1, guess: 0.1, estimatedSeconds: 40 },
      ],
      config: { minItems: 1, maxItems: 2, totalBudgetSeconds: 50 },
    });
    const tPick = timeSession.selectNextProbe();
    timeSession.recordResponse({ observationId: "tm-1", itemId: tPick.probe!.itemId, correct: true });
    const stoppedByTime = timeSession.selectNextProbe();
    expect(stoppedByTime.status).toBe("stopped");
    expect(stoppedByTime.stopReason).toBe("time_budget_exhausted");
  });
});

describe("Round-3 multi-merge lookahead, envelope gating, cap integrity & prototype-safety fixes", () => {
  const makeChain = (prefix: string, chapterId: string, len: number): DiagnosticSkillNode[] =>
    Array.from({ length: len }, (_, i) => ({
      skillId: `${prefix}_${i}`,
      chapterId,
      ...(i > 0 ? { prerequisiteIds: [`${prefix}_${i - 1}`] } : {}),
    }));

  it("[P1-1] simulates post-candidate merged component sizes so selecting A+B cannot strand chapter C's B+C probe", () => {
    const skills = [...makeChain("A", "chA", 27), ...makeChain("B", "chB", 27), ...makeChain("C", "chC", 27)];
    const probeAB: DiagnosticProbeItem = { itemId: "p-ab", familyId: "f-ab", chapterId: "chA", requiredSkillIds: ["A_26", "B_26"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 };
    const probeAOnly: DiagnosticProbeItem = { itemId: "p-a-only", familyId: "f-a-only", chapterId: "chA", requiredSkillIds: ["A_0"], slip: 0.25, guess: 0.25, estimatedSeconds: 20 };
    const probeBC: DiagnosticProbeItem = { itemId: "p-bc", familyId: "f-bc", chapterId: "chC", requiredSkillIds: ["B_26", "C_26"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 };

    const session = new DiagnosticPlacementSession({
      skills,
      candidatePool: [probeAB, probeAOnly, probeBC],
      config: { minItems: 2, maxItems: 3, totalBudgetSeconds: 120, chapterQuotas: { chA: 1, chC: 1 } },
    });

    // p-ab has highest MI (slip=guess=0.05), but picking it would make p-bc (784 * 28 = 21_952 > 20_000) infeasible!
    const sel1 = session.selectNextProbe();
    expect(sel1.status).toBe("selected");
    expect(sel1.probe?.itemId).not.toBe("p-ab");
    session.recordResponse({ observationId: "look-1", itemId: sel1.probe!.itemId, correct: true });

    const sel2 = session.selectNextProbe();
    expect(sel2.status).toBe("selected");
    session.recordResponse({ observationId: "look-2", itemId: sel2.probe!.itemId, correct: true });

    const summary = session.getSessionSummary();
    expect(summary.chapterCounts["chA"]).toBeGreaterThanOrEqual(1);
    expect(summary.chapterCounts["chC"]).toBeGreaterThanOrEqual(1);
  });

  it("[P1-2] enforces maxItems across assisted/hinted responses and validates direct recordResponse submissions", () => {
    const skills: DiagnosticSkillNode[] = [
      { skillId: "A", chapterId: "ch1" },
      { skillId: "B", chapterId: "ch2" },
    ];
    const pool: DiagnosticProbeItem[] = [
      { itemId: "q-a", familyId: "fa", chapterId: "ch1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 },
      { itemId: "q-b", familyId: "fb", chapterId: "ch2", requiredSkillIds: ["B"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 },
      { itemId: "q-a2", familyId: "fa2", chapterId: "ch1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 },
    ];

    // Assisted responses still increment total administeredCount and stop cleanly at maxItems = 2
    const hintedSession = new DiagnosticPlacementSession({
      skills,
      candidatePool: pool,
      config: { minItems: 1, maxItems: 2, totalBudgetSeconds: 100 },
    });
    const s1 = hintedSession.selectNextProbe();
    const r1 = hintedSession.recordResponse({ observationId: "h-1", itemId: s1.probe!.itemId, correct: true, channel: "assisted" });
    expect(r1.applied).toBe(false);
    expect(r1.administeredCount).toBe(1);

    const s2 = hintedSession.selectNextProbe();
    const r2 = hintedSession.recordResponse({ observationId: "h-2", itemId: s2.probe!.itemId, correct: true, channel: "hinted" });
    expect(r2.applied).toBe(false);
    expect(r2.administeredCount).toBe(2);
    expect(hintedSession.getSessionSummary().appliedEvidenceCount).toBe(0);
    expect(hintedSession.selectNextProbe().stopReason).toBe("max_items_reached");
    expect(() => hintedSession.recordResponse({ observationId: "h-3", itemId: "q-a2", correct: true })).toThrow(DiagnosticPlacementError);

    // Direct submission with pendingProbeId === null validates chapter maxItems, budget, and feasibility
    const directSession = new DiagnosticPlacementSession({
      skills,
      candidatePool: [
        { itemId: "c1-ok", familyId: "fc1", chapterId: "ch1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 30 },
        { itemId: "c1-over", familyId: "fc2", chapterId: "ch1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 90 },
      ],
      config: { minItems: 1, maxItems: 2, totalBudgetSeconds: 50, chapterQuotas: { ch1: { minItems: 0, maxItems: 1 } } },
    });
    expect(() => directSession.recordResponse({ observationId: "d-over-budget", itemId: "c1-over", correct: true })).toThrow(DiagnosticPlacementError);
    expect(directSession.recordResponse({ observationId: "d-ok", itemId: "c1-ok", correct: true }).administeredCount).toBe(1);
    expect(() => directSession.recordResponse({ observationId: "d-over-cap", itemId: "c1-over", correct: true })).toThrow(DiagnosticPlacementError);
    expect(directSession.getSessionSummary().administeredCount).toBe(1);
  });

  it("[P1-3] never grants inferred_ready from bounded_component_envelope approximations", () => {
    const boundedSkills: DiagnosticSkillNode[] = [
      { skillId: "ROOT", chapterId: "c1" },
      ...Array.from({ length: 16 }, (_, i) => ({ skillId: `LEAF_${String(i).padStart(2, "0")}`, chapterId: "c1", prerequisiteIds: ["ROOT"] })),
      { skillId: "EXACT_P", chapterId: "c2" },
      { skillId: "EXACT_CHILD", chapterId: "c2", prerequisiteIds: ["EXACT_P"] },
    ];
    const space = createKstStateSpace(boundedSkills);
    expect(space.approximationMode).toBe("bounded_component_envelope");
    const routes = classifyPlacementRoutes(space, boundedSkills, { readyThreshold: 0.1, skipThreshold: 0.99 });

    const leafRoute = routes.find(r => r.skillId === "LEAF_00")!;
    expect(leafRoute.parentsSatisfiedProbability).toBeGreaterThanOrEqual(0.1);
    expect(leafRoute.route).toBe("prerequisite_gap_blocked");

    // Disconnected exact component in the same graph remains certified
    const exactRoute = routes.find(r => r.skillId === "EXACT_CHILD")!;
    expect(exactRoute.route).toBe("inferred_ready");
  });

  it("[P1-4 & P1-5 & P2-3 & P2-6] enforces honest inconclusive drilldown, snapshot consumed rejection, and non-writable 2-probe cap", () => {
    const skills: DiagnosticSkillNode[] = [
      { skillId: "L0", chapterId: "c1" },
      { skillId: "L1", chapterId: "c1", prerequisiteIds: ["L0"] },
      { skillId: "TARGET", chapterId: "c1", prerequisiteIds: ["L1"] },
    ];
    const originalContext = { originalAttemptId: "att-r3", originalItemId: "item-r3", frozenDraftText: "x = ", frozenCursorOffset: 4, startedAtMs: 1_700_000_000_000 };

    // Empty/unrelated pool finalizes without fabricating deficits
    const noProbeMachine = new PrerequisiteDrilldownStateMachine({
      skills,
      targetSkillId: "TARGET",
      probePool: [{ itemId: "p-tgt-only", familyId: "ft", chapterId: "c1", requiredSkillIds: ["TARGET"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 }],
      originalContext,
    });
    const noPick = noProbeMachine.selectNextProbe();
    expect(noPick.status).toBe("restore_original_attempt");
    const noState = noProbeMachine.getState();
    expect(noState.rootCause).toBe("insufficient_diagnostic_evidence");
    expect(noState.confirmedDeficitSkillIds).toEqual([]);
    expect(noState.repairPlan.map(s => s.kind)).toEqual(["restore_original_attempt"]);

    // Non-writable maxTotalProbes + consumedProbeObservationIds rejection + mixed/assisted inconclusive outcome
    const kst = createKstStateSpace(skills);
    const pL0: DiagnosticProbeItem = { itemId: "dd-l0", familyId: "f-l0", chapterId: "c1", requiredSkillIds: ["L0"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 };
    const pL1: DiagnosticProbeItem = { itemId: "dd-l1", familyId: "f-l1", chapterId: "c1", requiredSkillIds: ["L1"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 };
    kst.applyProbeObservation(pL0, { observationId: "already-in-placement", itemId: "dd-l0", correct: true });
    const kstSnap = buildKstPriorSnapshot(kst);

    const machine = new PrerequisiteDrilldownStateMachine({
      skills,
      targetSkillId: "TARGET",
      probePool: [pL0, pL1],
      originalContext,
      maxProbes: 5,
      kstSnapshot: kstSnap,
    });
    expect(Reflect.set(machine, "maxTotalProbes", 4)).toBe(false);
    expect(machine.maxTotalProbes).toBe(MAX_TOTAL_DRILLDOWN_PROBES);

    expect(() => machine.recordProbeResponse({ observationId: "  already-in-placement  ", itemId: "dd-l0", correct: true })).toThrow(DiagnosticPlacementError);
    expect(machine.getState().probesAdministered).toBe(0);

    // 1 unassisted pass + 1 assisted pass -> cannot confirm deficit or coordination -> insufficient_diagnostic_evidence
    machine.recordProbeResponse({ observationId: "dd-u1", itemId: "dd-l0", correct: true });
    const finalMix = machine.recordProbeResponse({ observationId: "dd-a2", itemId: "dd-l1", correct: true, channel: "assisted" });
    expect(finalMix.rootCause).toBe("insufficient_diagnostic_evidence");
    expect(finalMix.confirmedDeficitSkillIds).toEqual([]);
    expect(finalMix.repairPlan.map(s => s.kind)).toEqual(["restore_original_attempt"]);

    // Empty-prerequisite target validates corrupted kstSnapshot once in constructor
    expect(() => new PrerequisiteDrilldownStateMachine({
      skills: [{ skillId: "ONLY", chapterId: "c1" }],
      targetSkillId: "ONLY",
      probePool: [],
      originalContext,
      kstSnapshot: { ...kstSnap, outerFringeBySkill: { ...kstSnap.outerFringeBySkill, L0: 2 } },
    })).toThrow(DiagnosticPlacementError);
  });

  it("[P2-1 & P2-2 & P2-4 & P2-5] handles __proto__/constructor IDs safely, preserves BigInt string count at 53 skills, avoids log overflow, and enforces strict snapshot invariants", () => {
    // P2-1: Prototype-safe skill IDs
    const protoSkills: DiagnosticSkillNode[] = [
      { skillId: "__proto__", chapterId: "__proto__" },
      { skillId: "constructor", chapterId: "c2", prerequisiteIds: ["__proto__"] },
    ];
    const protoSpace = createKstStateSpace(protoSkills);
    const protoSnap = buildKstPriorSnapshot(protoSpace);
    expect(Object.prototype).toEqual({});
    expect(typeof Object.getOwnPropertyDescriptor(protoSnap.piBySkill, "__proto__")?.value).toBe("number");
    expect(getSkillCovariance(protoSnap, "__proto__", "constructor")).toBeGreaterThan(0);
    const protoRoutes = classifyPlacementRoutes(protoSnap, protoSkills);
    expect(protoRoutes).toHaveLength(2);
    const protoDd = new PrerequisiteDrilldownStateMachine({
      skills: protoSkills,
      targetSkillId: "constructor",
      probePool: [{ itemId: "p-proto", familyId: "f-proto", chapterId: "__proto__", requiredSkillIds: ["__proto__"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 }],
      originalContext: { originalAttemptId: "a", originalItemId: "i", frozenDraftText: "", frozenCursorOffset: 0, startedAtMs: 1 },
      kstSnapshot: protoSnap,
    });
    expect(protoDd.selectNextProbe().probe?.itemId).toBe("p-proto");

    // P2-2: 53 independent skills => 2^53 = 9007199254740992 (> Number.MAX_SAFE_INTEGER)
    const ind53 = Array.from({ length: 53 }, (_, i) => ({ skillId: `K_${i}`, chapterId: "c1" }));
    const space53 = createKstStateSpace(ind53);
    expect(space53.totalFeasibleStateCount).toBeNull();
    expect(space53.totalFeasibleStateCountExact).toBe("9007199254740992");
    expect(buildKstPriorSnapshot(space53).totalFeasibleStateCountExact).toBe("9007199254740992");

    // P2-4: Overflow-safe log-likelihood ratio for Number.MIN_VALUE slip/guess
    const baseSnap = buildKstPriorSnapshot(createKstStateSpace([{ skillId: "Z", chapterId: "c1" }]));
    const minRes = updateSkillMasteryFromKstSnapshot(baseSnap, "Z", [
      { observationId: "min-1", skillId: "Z", correct: true, slip: Number.MIN_VALUE, guess: Number.MIN_VALUE },
      { observationId: "min-2", skillId: "Z", correct: false, slip: Number.MIN_VALUE, guess: Number.MIN_VALUE },
    ]);
    expect(Number.isFinite(minRes.posteriorProbability)).toBe(true);
    expect(minRes.posteriorProbability).toBeCloseTo(0.5, 10);

    // P2-5: Tight validateKstSnapshot & getSkillCovariance guards
    expect(() => validateKstSnapshot({ ...protoSnap, wByState: { "[]": 0.4 } })).toThrow(DiagnosticPlacementError);
    expect(() => validateKstSnapshot({ ...protoSnap, outerFringeBySkill: { ...protoSnap.outerFringeBySkill, constructor: 0.9 } })).toThrow(DiagnosticPlacementError);
    expect(() => validateKstSnapshot({ ...protoSnap, skillCovariance: { ...protoSnap.skillCovariance, ["__proto__"]: { ["__proto__"]: 0.5 } } })).toThrow(DiagnosticPlacementError);
    expect(() => getSkillCovariance({ ...protoSnap, skillCovariance: { constructor: { constructor: Number.NaN } } }, "constructor", "constructor")).toThrow(DiagnosticPlacementError);
  });
});
