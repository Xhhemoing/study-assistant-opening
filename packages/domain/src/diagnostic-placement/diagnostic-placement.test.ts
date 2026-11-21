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
    const probeAB: DiagnosticProbeItem = { itemId: "p-ab", familyId: "f-ab", chapterId: "chA", requiredSkillIds: ["A_8", "B_8"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 };
    const probeAOnly: DiagnosticProbeItem = { itemId: "p-a-only", familyId: "f-a-only", chapterId: "chA", requiredSkillIds: ["A_25"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 };
    const probeBC: DiagnosticProbeItem = { itemId: "p-bc", familyId: "f-bc", chapterId: "chC", requiredSkillIds: ["B_26", "C_26"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 };

    const session = new DiagnosticPlacementSession({
      skills,
      candidatePool: [probeAB, probeAOnly, probeBC],
      config: { minItems: 2, maxItems: 3, totalBudgetSeconds: 120, chapterQuotas: { chA: 1, chC: 1 } },
    });

    // Ensure p-ab would win purely on MI without multi-component lookahead
    expect(session.stateSpace.computeProbeMutualInformation(probeAB)).toBeGreaterThan(
      session.stateSpace.computeProbeMutualInformation(probeAOnly),
    );
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

describe("Round-4 multi-step completion DFS, component partition & evidence integrity", () => {
  const makeChain = (prefix: string, chapterId: string, len: number): DiagnosticSkillNode[] =>
    Array.from({ length: len }, (_, i) => ({
      skillId: `${prefix}_${i}`,
      chapterId,
      ...(i > 0 ? { prerequisiteIds: [`${prefix}_${i - 1}`] } : {}),
    }));

  it("[P1-1] rejects AB in 4-chain (16 states each) when AB + BC + CD exceeds 20_000 cumulatively, completing via A-only -> BC -> CD", () => {
    const skills = [
      ...makeChain("A", "ch1", 15),
      ...makeChain("B", "ch2", 15),
      ...makeChain("C", "ch3", 15),
      ...makeChain("D", "ch4", 15),
    ];
    const probeAB: DiagnosticProbeItem = { itemId: "ab", familyId: "f-ab", chapterId: "ch1", requiredSkillIds: ["A_4", "B_4"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 };
    const probeAOnly: DiagnosticProbeItem = { itemId: "a-only", familyId: "f-a", chapterId: "ch1", requiredSkillIds: ["A_14"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 };
    const probeBC: DiagnosticProbeItem = { itemId: "bc", familyId: "f-bc", chapterId: "ch2", requiredSkillIds: ["B_4", "C_4"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 };
    const probeCD: DiagnosticProbeItem = { itemId: "cd", familyId: "f-cd", chapterId: "ch3", requiredSkillIds: ["C_4", "D_4"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 };

    const session = new DiagnosticPlacementSession({
      skills,
      candidatePool: [probeAB, probeAOnly, probeBC, probeCD],
      config: { minItems: 3, maxItems: 3, totalBudgetSeconds: 120, chapterQuotas: { ch1: 1, ch2: 1, ch3: 1 } },
    });

    // Without multi-step lookahead, AB beats A-only on MI and both BC (4,096) and CD (256) look individually <= 20,000
    expect(session.stateSpace.computeProbeMutualInformation(probeAB)).toBeGreaterThan(
      session.stateSpace.computeProbeMutualInformation(probeAOnly),
    );
    const chosen: string[] = [];
    for (let step = 0; step < 3; step++) {
      const sel = session.selectNextProbe();
      expect(sel.status).toBe("selected");
      chosen.push(sel.probe!.itemId);
      session.recordResponse({ observationId: `r4-${step}`, itemId: sel.probe!.itemId, correct: true });
    }
    expect(chosen).not.toContain("ab");
    expect(new Set(chosen)).toEqual(new Set(["a-only", "bc", "cd"]));
    const summary = session.getSessionSummary();
    expect(summary.chapterCounts["ch1"]).toBe(1);
    expect(summary.chapterCounts["ch2"]).toBe(1);
    expect(summary.chapterCounts["ch3"]).toBe(1);
  });

  it("[P1-2] rejects duplicate or conflicting componentJointWeights partitions in validateKstSnapshot and classifyPlacementRoutes", () => {
    const boundedSkills: DiagnosticSkillNode[] = [
      { skillId: "ROOT", chapterId: "c1" },
      ...Array.from({ length: 16 }, (_, i) => ({ skillId: `LEAF_${String(i).padStart(2, "0")}`, chapterId: "c1", prerequisiteIds: ["ROOT"] })),
    ];
    const snap = buildKstPriorSnapshot(createKstStateSpace(boundedSkills));
    const spoofed = {
      ...snap,
      componentJointWeights: [
        ...snap.componentJointWeights,
        { componentId: "spoof-exact", skillIds: ["LEAF_00"], approximationMode: "exact" as const, exactStateCountEstimate: 2, stateCount: 2, wByState: { "[]": 0.5, '["LEAF_00"]': 0.5 } },
      ],
    };
    expect(() => validateKstSnapshot(spoofed)).toThrow(DiagnosticPlacementError);
    expect(() => classifyPlacementRoutes(spoofed, boundedSkills, { readyThreshold: 0.1 })).toThrow(DiagnosticPlacementError);

    const incomplete = {
      ...snap,
      componentJointWeights: [
        { ...snap.componentJointWeights[0]!, skillIds: ["ROOT"] },
      ],
    };
    expect(() => validateKstSnapshot(incomplete)).toThrow(DiagnosticPlacementError);
  });

  it("[P1-3] confirms drilldown deficits only from failed tested skills, uses insufficient_diagnostic_evidence on 0 prerequisites, and skips counters on zero-likelihood rollback", () => {
    const orig = { originalAttemptId: "a-r4", originalItemId: "i-r4", frozenDraftText: "", frozenCursorOffset: 0, startedAtMs: 1 };

    // Counterexample 1: T depends on A (prior=0.95) and B (prior=0.01); unassisted failure on pA must confirm A, never untested B
    const abSkills: DiagnosticSkillNode[] = [
      { skillId: "A", chapterId: "c1", priorMastery: 0.95 },
      { skillId: "B", chapterId: "c1", priorMastery: 0.01 },
      { skillId: "T", chapterId: "c1", prerequisiteIds: ["A", "B"] },
    ];
    const abSnap = buildKstPriorSnapshot(createKstStateSpace(abSkills));
    const abMachine = new PrerequisiteDrilldownStateMachine({
      skills: abSkills,
      targetSkillId: "T",
      probePool: [{ itemId: "p-a", familyId: "f-a", chapterId: "c1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 }],
      originalContext: orig,
      maxProbes: 1,
      kstSnapshot: abSnap,
    });
    const abState = abMachine.recordProbeResponse({ observationId: "fail-a", itemId: "p-a", correct: false });
    expect(abState.rootCause).toBe("prerequisite_deficit");
    expect(abState.confirmedDeficitSkillIds).toEqual(["A"]);

    // Counterexample 2: 0-prerequisite target skill finalizes as insufficient_diagnostic_evidence, never integration_step_coordination
    const zeroPrereq = new PrerequisiteDrilldownStateMachine({
      skills: [{ skillId: "SOLO", chapterId: "c1" }],
      targetSkillId: "SOLO",
      probePool: [],
      originalContext: orig,
    });
    const zeroState = zeroPrereq.getState();
    expect(zeroState.rootCause).toBe("insufficient_diagnostic_evidence");
    expect(zeroState.confirmedDeficitSkillIds).toEqual([]);

    // Step-1 P2: zero-likelihood rollback must not increment unassisted counts or fake deficit/coordination
    const chain: DiagnosticSkillNode[] = [
      { skillId: "L0", chapterId: "c1" },
      { skillId: "L1", chapterId: "c1", prerequisiteIds: ["L0"] },
      { skillId: "TARGET", chapterId: "c1", prerequisiteIds: ["L1"] },
    ];
    const p1: DiagnosticProbeItem = { itemId: "z-l0-1", familyId: "zf-1", chapterId: "c1", requiredSkillIds: ["L0"], slip: 0, guess: 0, estimatedSeconds: 20 };
    const p2: DiagnosticProbeItem = { itemId: "z-l0-2", familyId: "zf-2", chapterId: "c1", requiredSkillIds: ["L0"], slip: 0, guess: 0, estimatedSeconds: 20 };
    const pL1: DiagnosticProbeItem = { itemId: "z-l1", familyId: "zf-3", chapterId: "c1", requiredSkillIds: ["L1"], slip: 0.05, guess: 0.05, estimatedSeconds: 20 };
    const rbMachine = new PrerequisiteDrilldownStateMachine({ skills: chain, targetSkillId: "TARGET", probePool: [p1, p2, pL1], originalContext: orig, maxProbes: 2 });
    rbMachine.recordProbeResponse({ observationId: "rb-1", itemId: "z-l0-1", correct: true });
    // Now L0 deficit has weight 0; failing z-l0-2 with s=g=0 yields zero likelihood across ALL remaining hypotheses -> rollback
    const rbDone = rbMachine.recordProbeResponse({ observationId: "rb-2", itemId: "z-l0-2", correct: false });
    expect(rbDone.rootCause).toBe("insufficient_diagnostic_evidence");
    expect(rbDone.confirmedDeficitSkillIds).toEqual([]);
  });

  it("[P1-4 & P2-1] canonicalizes trimmed observationIds across all APIs and validates direct recordResponse budget against actual elapsedSeconds", () => {
    const space = createKstStateSpace([{ skillId: "A", chapterId: "c1" }]);
    const probe: DiagnosticProbeItem = { itemId: "q1", familyId: "f1", chapterId: "c1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 };
    const first = space.applyProbeObservation(probe, { observationId: "  obs-trim  ", itemId: "q1", correct: true });
    expect(first.applied).toBe(true);
    expect(first.observationId).toBe("obs-trim");
    const dup = space.applyProbeObservation(probe, { observationId: "obs-trim", itemId: "q1", correct: true });
    expect(dup.applied).toBe(false);
    expect(dup.reason).toBe("duplicate_observation");

    const snap = buildKstPriorSnapshot(space);
    expect(snap.consumedProbeObservationIds).toEqual(["obs-trim"]);
    const downstream = updateSkillMasteryFromKstSnapshot(snap, "A", [
      { observationId: " obs-trim ", skillId: "A", correct: true, slip: 0.1, guess: 0.1 },
      { observationId: " obs-fresh ", skillId: "A", correct: true, slip: 0.1, guess: 0.1 },
      { observationId: "obs-fresh", skillId: "A", correct: true, slip: 0.1, guess: 0.1 },
    ]);
    expect(downstream.appliedObservationIds).toEqual(["obs-fresh"]);
    expect(downstream.posteriorProbability).toBeCloseTo(81 / 82, 12);

    // P1-4 in DiagnosticPlacementSession & PrerequisiteDrilldownStateMachine
    const skills: DiagnosticSkillNode[] = [
      { skillId: "A", chapterId: "ch1" },
      { skillId: "B", chapterId: "ch2" },
    ];
    const pA: DiagnosticProbeItem = { itemId: "pa", familyId: "fa", chapterId: "ch1", requiredSkillIds: ["A"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 };
    const pB: DiagnosticProbeItem = { itemId: "pb", familyId: "fb", chapterId: "ch2", requiredSkillIds: ["B"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 };
    const sess = new DiagnosticPlacementSession({
      skills,
      candidatePool: [pA, pB],
      config: { minItems: 2, maxItems: 2, totalBudgetSeconds: 50, chapterQuotas: { ch1: 1, ch2: 1 } },
    });

    // P2-1: direct submission with actual elapsedSeconds = 35 leaves 15s < 20s needed for ch2 -> fails INFEASIBLE atomically
    expect(() => sess.recordResponse({ observationId: "direct-slow", itemId: "pa", correct: true, elapsedSeconds: 35 })).toThrow(DiagnosticPlacementError);
    expect(sess.getSessionSummary().remainingBudgetSeconds).toBe(50);
    expect(sess.getSessionSummary().administeredCount).toBe(0);

    sess.recordResponse({ observationId: "  sess-1  ", itemId: "pa", correct: true, elapsedSeconds: 20 });
    const sessDup = sess.recordResponse({ observationId: "sess-1", itemId: "pa", correct: true });
    expect(sessDup.applied).toBe(false);
    expect(sessDup.reason).toBe("duplicate_observation");

    const dd = new PrerequisiteDrilldownStateMachine({
      skills: [{ skillId: "P", chapterId: "ch1" }, { skillId: "T", chapterId: "ch1", prerequisiteIds: ["P"] }],
      targetSkillId: "T",
      probePool: [{ itemId: "ddp", familyId: "fdd", chapterId: "ch1", requiredSkillIds: ["P"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 }],
      originalContext: { originalAttemptId: "a", originalItemId: "i", frozenDraftText: "", frozenCursorOffset: 0, startedAtMs: 1 },
      kstSnapshot: snap,
    });
    expect(() => dd.recordProbeResponse({ observationId: " obs-trim ", itemId: "ddp", correct: true })).toThrow(DiagnosticPlacementError);
    const dd1 = dd.recordProbeResponse({ observationId: "  dd-obs  ", itemId: "ddp", correct: false });
    const ddReplay = dd.recordProbeResponse({ observationId: "dd-obs", itemId: "ddp", correct: false });
    expect(ddReplay.probesAdministered).toBe(dd1.probesAdministered);
  });
});

describe("Round-5 falsified-posterior drilldown guard & sparse snapshot validation", () => {
  it("[P1-1] refuses to confirm a deterministically falsified (posterior === 0) prerequisite across forward and reverse probe orders", () => {
    const chain: DiagnosticSkillNode[] = [
      { skillId: "L0", chapterId: "c1" },
      { skillId: "L1", chapterId: "c1", prerequisiteIds: ["L0"] },
      { skillId: "TARGET", chapterId: "c1", prerequisiteIds: ["L1"] },
    ];
    const orig = { originalAttemptId: "a-r5", originalItemId: "i-r5", frozenDraftText: "", frozenCursorOffset: 0, startedAtMs: 1 };
    const probeL0: DiagnosticProbeItem = { itemId: "p-l0", familyId: "f-l0", chapterId: "c1", requiredSkillIds: ["L0"], slip: 0.1, guess: 0.1, estimatedSeconds: 20 };
    const probeL1Exact: DiagnosticProbeItem = { itemId: "p-l1", familyId: "f-l1", chapterId: "c1", requiredSkillIds: ["L1"], slip: 0, guess: 0, estimatedSeconds: 20 };

    // Forward: pL0(0.1, 0.1) fails first, then pL1(0, 0) passes -> posterior(L0) becomes 0 -> must not confirm L0
    const forward = new PrerequisiteDrilldownStateMachine({
      skills: chain,
      targetSkillId: "TARGET",
      probePool: [probeL0, probeL1Exact],
      originalContext: orig,
      maxProbes: 2,
    });
    forward.recordProbeResponse({ observationId: "r5-f1", itemId: "p-l0", correct: false });
    const forwardDone = forward.recordProbeResponse({ observationId: "r5-f2", itemId: "p-l1", correct: true });
    expect(forwardDone.posteriors.find(p => p.skillId === "L0")?.probability).toBe(0);
    expect(forwardDone.rootCause).toBe("insufficient_diagnostic_evidence");
    expect(forwardDone.confirmedDeficitSkillIds).toEqual([]);
    expect(forwardDone.repairPlan.map(s => s.kind)).toEqual(["restore_original_attempt"]);

    // Reverse: pL1(0, 0) passes first -> drives L0 & L1 posteriors to 0 immediately, finalizing without confirming 0-posterior skills
    const reverse = new PrerequisiteDrilldownStateMachine({
      skills: chain,
      targetSkillId: "TARGET",
      probePool: [probeL0, probeL1Exact],
      originalContext: orig,
      maxProbes: 2,
    });
    const reverseDone = reverse.recordProbeResponse({ observationId: "r5-r1", itemId: "p-l1", correct: true });
    expect(reverseDone.posteriors.find(p => p.skillId === "L0")?.probability).toBe(0);
    expect(reverseDone.posteriors.find(p => p.skillId === "L1")?.probability).toBe(0);
    expect(reverseDone.confirmedDeficitSkillIds).toEqual([]);
  });

  it("[P2-1] rejects sparse-array holes in componentJointWeights and consumedProbeObservationIds with VALIDATION", () => {
    const snap = buildKstPriorSnapshot(createKstStateSpace([{ skillId: "A", chapterId: "c1" }]));

    const sparseComponents = new Array<typeof snap.componentJointWeights[number]>(2);
    sparseComponents[1] = snap.componentJointWeights[0]!;
    try {
      validateKstSnapshot({ ...snap, componentJointWeights: sparseComponents });
      expect.unreachable("should reject sparse componentJointWeights");
    } catch (err) {
      expect(err).toBeInstanceOf(DiagnosticPlacementError);
      expect((err as DiagnosticPlacementError).code).toBe("VALIDATION");
    }

    const sparseConsumed = new Array<string>(2);
    sparseConsumed[1] = "obs-1";
    try {
      validateKstSnapshot({ ...snap, consumedProbeObservationIds: sparseConsumed });
      expect.unreachable("should reject sparse consumedProbeObservationIds");
    } catch (err) {
      expect(err).toBeInstanceOf(DiagnosticPlacementError);
      expect((err as DiagnosticPlacementError).code).toBe("VALIDATION");
    }
  });
});

describe("Round-6 aggregate/component mode parity, redundant-variant DFS & sparse probe IDs", () => {
  it("[P1-1] rejects bounded snapshot claiming all components exact or empty componentJointWeights", () => {
    const boundedSkills: DiagnosticSkillNode[] = [
      { skillId: "ROOT", chapterId: "c1" },
      ...Array.from({ length: 16 }, (_, i) => ({ skillId: `LEAF_${String(i).padStart(2, "0")}`, chapterId: "c1", prerequisiteIds: ["ROOT"] })),
    ];
    const snap = buildKstPriorSnapshot(createKstStateSpace(boundedSkills));
    expect(snap.approximationMode).toBe("bounded_component_envelope");
    expect(snap.totalFeasibleStateCountExact).toBeNull();

    // Forged sole component approximationMode -> "exact" while snapshot claims bounded_component_envelope
    const forgedComp = {
      ...snap,
      componentJointWeights: [
        { ...snap.componentJointWeights[0]!, approximationMode: "exact" as const },
      ],
    };
    expect(() => validateKstSnapshot(forgedComp)).toThrow(DiagnosticPlacementError);
    expect(() => classifyPlacementRoutes(forgedComp, boundedSkills, { readyThreshold: 0.1 })).toThrow(DiagnosticPlacementError);

    // Forged empty componentJointWeights on a populated snapshot
    expect(() => validateKstSnapshot({ ...snap, componentJointWeights: [] })).toThrow(DiagnosticPlacementError);
  });

  it("[P2-1] finds feasible 3x28-state schedule despite 40 X singles + 21 AB + 20 AC redundant variants without DFS cutoff", () => {
    const makeChain = (prefix: string, chapterId: string, len: number): DiagnosticSkillNode[] =>
      Array.from({ length: len }, (_, i) => ({
        skillId: `${prefix}_${i}`,
        chapterId,
        ...(i > 0 ? { prerequisiteIds: [`${prefix}_${i - 1}`] } : {}),
      }));

    // 3 independent chains of 27 skills => 28 states each (28^2 = 784 <= 20_000, 28^3 = 21_952 > 20_000)
    const skills = [
      ...makeChain("A", "Q", 27),
      ...makeChain("B", "X", 27),
      ...makeChain("C", "Y", 27),
    ];
    const pool: DiagnosticProbeItem[] = [
      { itemId: "q-0", familyId: "fam-q", chapterId: "Q", requiredSkillIds: ["A_0"], slip: 0.1, guess: 0.1, estimatedSeconds: 1 },
      // X has 40 single-component probes, first sharing fam-shared with Y's sole single-component probe
      { itemId: "x-shared", familyId: "fam-shared", chapterId: "X", requiredSkillIds: ["B_0"], slip: 0.1, guess: 0.1, estimatedSeconds: 1 },
      ...Array.from({ length: 39 }, (_, i) => ({
        itemId: `x-${String(i).padStart(2, "0")}`,
        familyId: `fam-x-${i}`,
        chapterId: "X",
        requiredSkillIds: ["B_1"],
        slip: 0.1,
        guess: 0.1,
        estimatedSeconds: 1,
      })),
      // Y has 21 AB variants (same family) + 20 AC variants (same family) + 1 single sharing fam-shared
      ...Array.from({ length: 21 }, (_, i) => ({
        itemId: `y-ab-${i}`,
        familyId: "fam-y-ab",
        chapterId: "Y",
        requiredSkillIds: ["A_2", "B_2"],
        slip: 0.05,
        guess: 0.05,
        estimatedSeconds: 1,
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        itemId: `y-ac-${i}`,
        familyId: "fam-y-ac",
        chapterId: "Y",
        requiredSkillIds: ["A_3", "C_3"],
        slip: 0.05,
        guess: 0.05,
        estimatedSeconds: 1,
      })),
      { itemId: "y-shared", familyId: "fam-shared", chapterId: "Y", requiredSkillIds: ["C_0"], slip: 0.1, guess: 0.1, estimatedSeconds: 1 },
    ];

    const session = new DiagnosticPlacementSession({
      skills,
      candidatePool: pool,
      config: { minItems: 8, maxItems: 8, totalBudgetSeconds: 8, chapterQuotas: { Q: 1, X: 5, Y: 2 } },
    });

    // Also verify the exact post-Q counterexample state (Q=1 done, X=5 and Y=2 remaining with 40/21/20 redundant variants)
    const afterQSession = new DiagnosticPlacementSession({
      skills,
      candidatePool: pool,
      config: { minItems: 8, maxItems: 8, totalBudgetSeconds: 8, chapterQuotas: { Q: 1, X: 5, Y: 2 } },
    });
    afterQSession.recordResponse({ observationId: "r6-post-q", itemId: "q-0", correct: true });
    for (let step = 1; step < 8; step++) {
      const sel = afterQSession.selectNextProbe();
      expect(sel.status).toBe("selected");
      afterQSession.recordResponse({ observationId: `r6-postq-${step}`, itemId: sel.probe!.itemId, correct: true });
    }
    const postQSummary = afterQSession.getSessionSummary();
    expect(postQSummary.chapterCounts["Q"]).toBe(1);
    expect(postQSummary.chapterCounts["X"]).toBe(5);
    expect(postQSummary.chapterCounts["Y"]).toBe(2);

    // Complete all 8 steps directly from step 0 -> must never hit DFS cutoff or false INFEASIBLE
    for (let step = 0; step < 8; step++) {
      const sel = session.selectNextProbe();
      expect(sel.status).toBe("selected");
      session.recordResponse({ observationId: `r6-step-${step}`, itemId: sel.probe!.itemId, correct: true });
    }
    const summary = session.getSessionSummary();
    expect(summary.administeredCount).toBe(8);
    expect(summary.chapterCounts["Q"]).toBe(1);
    expect(summary.chapterCounts["X"]).toBe(5);
    expect(summary.chapterCounts["Y"]).toBe(2);
  });

  it("[P2-2] rejects sparse-array holes in probe.requiredSkillIds inside validateProbeItem with VALIDATION", () => {
    const space = createKstStateSpace([{ skillId: "A", chapterId: "c1" }]);
    const sparseSkills = new Array<string>(1);
    const badProbe: DiagnosticProbeItem = {
      itemId: "bad-sparse",
      familyId: "f-bad",
      chapterId: "c1",
      requiredSkillIds: sparseSkills,
      slip: 0.1,
      guess: 0.1,
      estimatedSeconds: 20,
    };
    expect(() => space.computeProbeMutualInformation(badProbe)).toThrow(DiagnosticPlacementError);
    expect(space.canEvaluateProbe(badProbe)).toBe(false);
    expect(() => new DiagnosticPlacementSession({
      skills: [{ skillId: "A", chapterId: "c1" }],
      candidatePool: [badProbe],
      config: { minItems: 1, maxItems: 1 },
    })).toThrow(DiagnosticPlacementError);
  });
});

describe("Round-7 DAG snapshot certification, 8-12/900s Wave P limits, merge-only DFS & collision-free maps", () => {
  it("[P1-1] rejects forged bounded snapshots relabeled exact under true DAG, rejects duplicate state keys, and requires exact string on 53-root snapshot", () => {
    const starSkills: DiagnosticSkillNode[] = [
      { skillId: "ROOT", chapterId: "c1" },
      ...Array.from({ length: 16 }, (_, i) => ({ skillId: `LEAF_${String(i).padStart(2, "0")}`, chapterId: "c1", prerequisiteIds: ["ROOT"] })),
    ];
    const boundedSnap = buildKstPriorSnapshot(createKstStateSpace(starSkills));
    const boundedComp = boundedSnap.componentJointWeights[0]!;

    // Fully relabel both snapshot AND component to "exact" with matching retained stateCount -> still fails DAG verification!
    const fullyForged = {
      ...boundedSnap,
      approximationMode: "exact" as const,
      totalFeasibleStateCount: boundedComp.stateCount,
      totalFeasibleStateCountExact: String(boundedComp.stateCount),
      componentJointWeights: [
        {
          ...boundedComp,
          approximationMode: "exact" as const,
          exactStateCountEstimate: boundedComp.stateCount,
        },
      ],
    };
    expect(() => classifyPlacementRoutes(fullyForged, starSkills, { readyThreshold: 0.1, skipThreshold: 1 })).toThrow(DiagnosticPlacementError);
    expect(() => validateKstSnapshot(fullyForged, starSkills)).toThrow(DiagnosticPlacementError);

    // Reject duplicate skill IDs inside state key like ["A", "A"]
    const smallSnap = buildKstPriorSnapshot(createKstStateSpace([{ skillId: "A", chapterId: "c1" }]));
    expect(() => validateKstSnapshot({ ...smallSnap, wByState: { "[]": 0.5, '["A","A"]': 0.5 } })).toThrow(DiagnosticPlacementError);

    // 53-root snapshot requires totalFeasibleStateCountExact === String(2n ** 53n) and rejects null
    const roots53 = Array.from({ length: 53 }, (_, i) => ({ skillId: `R_${i}`, chapterId: "c1" }));
    const snap53 = buildKstPriorSnapshot(createKstStateSpace(roots53));
    expect(() => validateKstSnapshot({ ...snap53, totalFeasibleStateCountExact: null })).toThrow(DiagnosticPlacementError);
    expect(() => validateKstSnapshot({ ...snap53, totalFeasibleStateCountExact: (2n ** 53n).toString() })).not.toThrow();
  });

  it("[P1-2] enforces Wave P 8-12 item and 900s defaults/ceilings plus unconditional elapsedSeconds > remainingBudgetSeconds guard", () => {
    const skills8 = Array.from({ length: 8 }, (_, i) => ({ skillId: `W_${i}`, chapterId: `c${i}` }));
    const pool8: DiagnosticProbeItem[] = skills8.map((s, i) => ({
      itemId: `w-item-${i}`,
      familyId: `w-fam-${i}`,
      chapterId: s.chapterId,
      requiredSkillIds: [s.skillId],
      slip: 0.1,
      guess: 0.1,
      estimatedSeconds: 60,
    }));

    // Default config (8..12 items, 900s) completes 8 x 60s probes cleanly (480s <= 900s)
    const defaultSession = new DiagnosticPlacementSession({ skills: skills8, candidatePool: pool8 });
    expect(defaultSession.minItems).toBe(8);
    expect(defaultSession.maxItems).toBe(12);
    expect(defaultSession.totalBudgetSeconds).toBe(900);
    for (let i = 0; i < 8; i++) {
      const sel = defaultSession.selectNextProbe();
      expect(sel.status).toBe("selected");
      defaultSession.recordResponse({ observationId: `w-obs-${i}`, itemId: sel.probe!.itemId, correct: true });
    }
    expect(defaultSession.getSessionSummary().administeredCount).toBe(8);
    expect(defaultSession.getSessionSummary().remainingBudgetSeconds).toBe(420);

    // Hard ceilings: maxItems > 12 or totalBudgetSeconds > 900 rejected
    expect(() => new DiagnosticPlacementSession({ skills: skills8, candidatePool: pool8, config: { minItems: 8, maxItems: 13 } })).toThrow(DiagnosticPlacementError);
    expect(() => new DiagnosticPlacementSession({ skills: skills8, candidatePool: pool8, config: { minItems: 8, maxItems: 12, totalBudgetSeconds: 901 } })).toThrow(DiagnosticPlacementError);

    // Pending probe elapsedSeconds > remainingBudgetSeconds fails closed INFEASIBLE without applying evidence
    const boundedSess = new DiagnosticPlacementSession({
      skills: skills8,
      candidatePool: pool8,
      config: { minItems: 8, maxItems: 12, totalBudgetSeconds: 900 },
    });
    const pending = boundedSess.selectNextProbe();
    expect(pending.status).toBe("selected");
    try {
      boundedSess.recordResponse({ observationId: "too-long-pending", itemId: pending.probe!.itemId, correct: true, elapsedSeconds: 901 });
      expect.unreachable("should throw INFEASIBLE");
    } catch (err) {
      expect(err).toBeInstanceOf(DiagnosticPlacementError);
      expect((err as DiagnosticPlacementError).code).toBe("INFEASIBLE");
    }
    expect(boundedSess.getSessionSummary().remainingBudgetSeconds).toBe(900);
    expect(boundedSess.getSessionSummary().administeredCount).toBe(0);
    expect(boundedSess.getSessionSummary().consumedProbeObservationIds).toEqual([]);
  });

  it("[P2-1] solves GPT 3x28-state counterexample (X=6, Y=1, Z=1 with zero-cap twins & 31 AC/AB variants) via merge-only DFS", () => {
    const makeChain = (prefix: string, chapterId: string, len: number): DiagnosticSkillNode[] =>
      Array.from({ length: len }, (_, i) => ({
        skillId: `${prefix}_${i}`,
        chapterId,
        ...(i > 0 ? { prerequisiteIds: [`${prefix}_${i - 1}`] } : {}),
      }));

    // 3 chains of 27 skills => 28 states each (28^2 = 784 <= 20_000, 28^3 = 21_952 > 20_000)
    const skills = [
      ...makeChain("A", "Q", 27),
      ...makeChain("B", "X", 27),
      ...makeChain("C", "Y", 27),
      { skillId: "Z_0", chapterId: "Z" },
      { skillId: "DEAD_0", chapterId: "ZERO" },
    ];
    const pool: DiagnosticProbeItem[] = [
      { itemId: "q-0", familyId: "fam-q", chapterId: "Q", requiredSkillIds: ["A_0"], slip: 0.1, guess: 0.1, estimatedSeconds: 1 },
      // X has 30 single-group probes (paired with ZERO maxItems=0 chapter twins), cheapest shares fam-shared with Y's sole AB probe
      { itemId: "x-shared", familyId: "fam-shared", chapterId: "X", requiredSkillIds: ["B_0"], slip: 0.1, guess: 0.1, estimatedSeconds: 1 },
      { itemId: "dead-shared", familyId: "fam-shared", chapterId: "ZERO", requiredSkillIds: ["DEAD_0"], slip: 0.1, guess: 0.1, estimatedSeconds: 1 },
      ...Array.from({ length: 29 }, (_, i) => ([
        { itemId: `x-${i}`, familyId: `fam-x-${i}`, chapterId: "X", requiredSkillIds: ["B_1"], slip: 0.1, guess: 0.1, estimatedSeconds: 2 },
        { itemId: `dead-${i}`, familyId: `fam-x-${i}`, chapterId: "ZERO", requiredSkillIds: ["DEAD_0"], slip: 0.1, guess: 0.1, estimatedSeconds: 1 },
      ])).flat(),
      // Y has 1 AB probe sharing fam-shared + 31 AC probes in distinct families
      { itemId: "y-ab-sole", familyId: "fam-shared", chapterId: "Y", requiredSkillIds: ["A_2", "B_2"], slip: 0.05, guess: 0.05, estimatedSeconds: 1 },
      ...Array.from({ length: 31 }, (_, i) => ({
        itemId: `y-ac-${i}`,
        familyId: `fam-yac-${i}`,
        chapterId: "Y",
        requiredSkillIds: ["A_3", "C_3"],
        slip: 0.05,
        guess: 0.05,
        estimatedSeconds: 1,
      })),
      // Z has 31 AB probes in distinct families (after Y picks y-ab-sole, A+B are already merged so Z's AB probes become single-group!)
      ...Array.from({ length: 31 }, (_, i) => ({
        itemId: `z-ab-${i}`,
        familyId: `fam-zab-${i}`,
        chapterId: "Z",
        requiredSkillIds: ["A_4", "B_4"],
        slip: 0.05,
        guess: 0.05,
        estimatedSeconds: 1,
      })),
    ];

    const session = new DiagnosticPlacementSession({
      skills,
      candidatePool: pool,
      config: {
        minItems: 9,
        maxItems: 9,
        totalBudgetSeconds: 60,
        chapterQuotas: { Q: 1, X: 6, Y: 1, Z: 1, ZERO: { minItems: 0, maxItems: 0 } },
      },
    });
    session.recordResponse({ observationId: "obs-q0", itemId: "q-0", correct: true });
    for (let step = 1; step < 9; step++) {
      const sel = session.selectNextProbe();
      expect(sel.status).toBe("selected");
      session.recordResponse({ observationId: `obs-r7-${step}`, itemId: sel.probe!.itemId, correct: true });
    }
    const summary = session.getSessionSummary();
    expect(summary.chapterCounts["Q"]).toBe(1);
    expect(summary.chapterCounts["X"]).toBe(6);
    expect(summary.chapterCounts["Y"]).toBe(1);
    expect(summary.chapterCounts["Z"]).toBe(1);
  });

  it("[P2-2] avoids NUL-separator key collisions between familyId and chapterId across 8 required chapters", () => {
    const chapters = ["x\0y", "y", "p\0q", "q", "ch5", "ch6", "ch7", "ch8"];
    const skills: DiagnosticSkillNode[] = chapters.map((ch, i) => ({ skillId: `S_${i}`, chapterId: ch }));
    const pool: DiagnosticProbeItem[] = [
      { itemId: "col-1", familyId: "f", chapterId: "x\0y", requiredSkillIds: ["S_0"], slip: 0.1, guess: 0.1, estimatedSeconds: 10 },
      { itemId: "col-2", familyId: "f\0x", chapterId: "y", requiredSkillIds: ["S_1"], slip: 0.1, guess: 0.1, estimatedSeconds: 10 },
      { itemId: "col-3", familyId: "g", chapterId: "p\0q", requiredSkillIds: ["S_2"], slip: 0.1, guess: 0.1, estimatedSeconds: 10 },
      { itemId: "col-4", familyId: "g\0p", chapterId: "q", requiredSkillIds: ["S_3"], slip: 0.1, guess: 0.1, estimatedSeconds: 10 },
      { itemId: "col-5", familyId: "f5", chapterId: "ch5", requiredSkillIds: ["S_4"], slip: 0.1, guess: 0.1, estimatedSeconds: 10 },
      { itemId: "col-6", familyId: "f6", chapterId: "ch6", requiredSkillIds: ["S_5"], slip: 0.1, guess: 0.1, estimatedSeconds: 10 },
      { itemId: "col-7", familyId: "f7", chapterId: "ch7", requiredSkillIds: ["S_6"], slip: 0.1, guess: 0.1, estimatedSeconds: 10 },
      { itemId: "col-8", familyId: "f8", chapterId: "ch8", requiredSkillIds: ["S_7"], slip: 0.1, guess: 0.1, estimatedSeconds: 10 },
    ];
    const chapterQuotas: Record<string, number> = Object.fromEntries(chapters.map(c => [c, 1]));
    const session = new DiagnosticPlacementSession({
      skills,
      candidatePool: pool,
      config: { minItems: 8, maxItems: 8, totalBudgetSeconds: 80, chapterQuotas },
    });
    for (let i = 0; i < 8; i++) {
      const sel = session.selectNextProbe();
      expect(sel.status).toBe("selected");
      session.recordResponse({ observationId: `nul-${i}`, itemId: sel.probe!.itemId, correct: true });
    }
    expect(session.getSessionSummary().administeredCount).toBe(8);
  });
});
