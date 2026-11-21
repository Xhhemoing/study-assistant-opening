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

    // Assisted probes must never qualify as integration_step_coordination
    const assisted = new PrerequisiteDrilldownStateMachine({ skills: chainSkills, targetSkillId: "TARGET", probePool: chainProbes, originalContext, maxProbes: 1 });
    const aSel = assisted.selectNextProbe();
    const aDone = assisted.recordProbeResponse({ observationId: "a-pass", itemId: aSel.probe!.itemId, correct: true, channel: "assisted" });
    expect(aDone.status).toBe("repair_plan_ready");
    expect(aDone.rootCause).toBe("prerequisite_deficit");
  });
});
