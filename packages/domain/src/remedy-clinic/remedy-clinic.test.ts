import { describe, expect, it, vi } from "vitest";
import type { DistinguishableProbeSpec } from "../opening/cartridges/probe-protocol";
import {
  areSourceRefsActive,
  computeEvidenceCoverage,
  generateRemedyClinic,
  isSourceRefActive,
  meetsClinicThreshold,
  revalidateRemedyClinic,
  selectSpreadRepresentativeCases,
  type ActiveSourcesMap,
  type ClinicCandidateProbe,
  type DiagnosedRootAttempt,
} from "./index";
import {
  cloneEvidenceCase,
  cloneSourceRefs,
  inspectActiveSourcesMap,
  snapshotActiveSourcesMap,
} from "./privacy-guard";

const RULE_ID = "inequality_negative_sign_flip";

interface InequalityInput {
  readonly a: number;
  readonly b: number;
}

function makeProbe(options: {
  probeId: string;
  input: InequalityInput;
  degenerate?: boolean;
  ambiguousHypotheses?: boolean;
  targetMisconceptionId?: string;
}): ClinicCandidateProbe<InequalityInput, string> {
  return {
    probeId: options.probeId,
    requirementKey: "alg.linear-inequalities",
    prompt: `Solve ${options.input.a}x <= ${options.input.b} for x.`,
    targetMisconceptionId: options.targetMisconceptionId ?? RULE_ID,
    input: options.input,
    correctModel: {
      id: "M_star",
      label: "Flip inequality sign when dividing by a negative coefficient",
      role: "correct",
      predict: ({ a, b }) => `x >= ${b / a}`,
    },
    hypotheses: [
      {
        id: RULE_ID,
        label: "Forgot sign flip on negative division",
        role: "misconception",
        description: "Preserves <= instead of flipping to >= when dividing by negative a.",
        predict: ({ a, b }) => (options.degenerate ? `x >= ${b / a}` : `x <= ${b / a}`),
      },
      {
        id: "sign_dropped_rhs",
        label: "Dropped negative sign on RHS division",
        role: "misconception",
        description: "Divides by |a| while keeping the original inequality direction.",
        predict: ({ a, b }) => (options.ambiguousHypotheses ? `x <= ${b / a}` : `x <= ${b / Math.abs(a)}`),
      },
    ],
    observableKey: (obs) => obs.trim(),
    parseResponse: (response) => (typeof response === "string" && response.trim() ? response.trim() : null),
  };
}

function makeAttempt(overrides: Partial<DiagnosedRootAttempt> & Pick<DiagnosedRootAttempt, "attemptId" | "rootAttemptId" | "chapterId" | "localDate">): DiagnosedRootAttempt {
  return {
    learnerId: "learner-1",
    courseId: "course-alg-1",
    ruleId: RULE_ID,
    excerpt: `SECRET_EXCERPT_${overrides.rootAttemptId}: -2x <= 8 => x <= -4`,
    invariantSummary: "Dividing an inequality by a negative number reverses the comparison direction.",
    sourceRefs: [{ sourceId: `src-${overrides.chapterId}`, sourceVersion: "v1" }],
    privacyEpoch: 5,
    assisted: false,
    ...overrides,
  };
}

const DEFAULT_SOURCES: ActiveSourcesMap = new Map([
  ["src-ch-1", { version: "v1", active: true }],
  ["src-ch-2", { version: "v1", active: true }],
  ["src-ch-3", { version: "v1", active: true }],
]);

const verifyNegativeSignFlip = (attempt: DiagnosedRootAttempt): boolean =>
  attempt.ruleId === RULE_ID && attempt.excerpt.includes("=> x <=");

describe("RemedyClinicGenerator clustering, deduplication & anti-transitive-closure", () => {
  it("deduplicates retries by rootAttemptId and enforces >=3 roots x >=2 chapters x >=2 local days", () => {
    const probes = [
      makeProbe({ probeId: "probe-1", input: { a: -2, b: 8 } }),
      makeProbe({ probeId: "probe-2", input: { a: -3, b: 12 } }),
    ];

    // 4 retries of root-1 across 3 days plus 1 distinct root-2 => only 2 distinct roots.
    const retryOnly = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: DEFAULT_SOURCES,
      verifyRuleViolation: verifyNegativeSignFlip,
      candidateProbes: probes,
      attempts: [
        makeAttempt({ attemptId: "a1", rootAttemptId: "root-1", chapterId: "ch-1", localDate: "2026-11-01" }),
        makeAttempt({ attemptId: "a2", rootAttemptId: "root-1", chapterId: "ch-1", localDate: "2026-11-02" }),
        makeAttempt({ attemptId: "a3", rootAttemptId: "root-1", chapterId: "ch-2", localDate: "2026-11-03" }),
        makeAttempt({ attemptId: "a4", rootAttemptId: "root-2", chapterId: "ch-2", localDate: "2026-11-03" }),
      ],
    });
    expect(retryOnly.status).toBe("threshold_not_met");
    expect(retryOnly.clinic).toBeNull();
    expect(retryOnly.coverage.rootAttemptCount).toBe(2);
    expect(retryOnly.rejectedCounts.duplicateRoot).toBe(2);

    // Same calendar day across 3 roots & 3 chapters => fails cross-day requirement.
    const sameDay = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: DEFAULT_SOURCES,
      verifyRuleViolation: verifyNegativeSignFlip,
      candidateProbes: probes,
      attempts: [
        makeAttempt({ attemptId: "d1", rootAttemptId: "r1", chapterId: "ch-1", localDate: "2026-11-01" }),
        makeAttempt({ attemptId: "d2", rootAttemptId: "r2", chapterId: "ch-2", localDate: "2026-11-01" }),
        makeAttempt({ attemptId: "d3", rootAttemptId: "r3", chapterId: "ch-3", localDate: "2026-11-01" }),
      ],
    });
    expect(sameDay.status).toBe("threshold_not_met");
    expect(sameDay.coverage.localDateCount).toBe(1);

    // Same chapter across 3 roots & 3 days => fails cross-chapter requirement.
    const sameChapter = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: DEFAULT_SOURCES,
      verifyRuleViolation: verifyNegativeSignFlip,
      candidateProbes: probes,
      attempts: [
        makeAttempt({ attemptId: "c1", rootAttemptId: "r1", chapterId: "ch-1", localDate: "2026-11-01" }),
        makeAttempt({ attemptId: "c2", rootAttemptId: "r2", chapterId: "ch-1", localDate: "2026-11-02" }),
        makeAttempt({ attemptId: "c3", rootAttemptId: "r3", chapterId: "ch-1", localDate: "2026-11-03" }),
      ],
    });
    expect(sameChapter.status).toBe("threshold_not_met");
    expect(sameChapter.coverage.chapterCount).toBe(1);
  });

  it("blocks A~B, B~C embedding transitive closure, assisted attempts, stale epochs, and failed verifiers", () => {
    const probes = [
      makeProbe({ probeId: "probe-1", input: { a: -2, b: 8 } }),
      makeProbe({ probeId: "probe-2", input: { a: -3, b: 12 } }),
    ];

    const result = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: DEFAULT_SOURCES,
      verifyRuleViolation: verifyNegativeSignFlip,
      candidateProbes: probes,
      attempts: [
        makeAttempt({ attemptId: "ok-1", rootAttemptId: "r1", chapterId: "ch-1", localDate: "2026-11-01" }),
        makeAttempt({ attemptId: "ok-2", rootAttemptId: "r2", chapterId: "ch-2", localDate: "2026-11-02" }),
        makeAttempt({ attemptId: "assisted-3", rootAttemptId: "r3", chapterId: "ch-3", localDate: "2026-11-03", assisted: true }),
        makeAttempt({ attemptId: "old-epoch-4", rootAttemptId: "r4", chapterId: "ch-3", localDate: "2026-11-04", privacyEpoch: 4 }),
        makeAttempt({
          attemptId: "revoked-src-5",
          rootAttemptId: "r5",
          chapterId: "ch-3",
          localDate: "2026-11-05",
          sourceRefs: [{ sourceId: "src-deleted", sourceVersion: "v1" }],
        }),
      ],
      embeddingRecallCandidates: [
        {
          // High cosine similarity A~B, but different ruleId => must NOT merge.
          cosineSimilarity: 0.98,
          anchorAttemptId: "ok-2",
          attempt: makeAttempt({
            attemptId: "emb-diff-rule",
            rootAttemptId: "r6",
            chapterId: "ch-3",
            localDate: "2026-11-06",
            ruleId: "other_misconception_rule",
          }),
        },
        {
          // Matching ruleId from embedding recall, but deterministic verifier returns false.
          cosineSimilarity: 0.96,
          anchorAttemptId: "emb-diff-rule",
          attempt: makeAttempt({
            attemptId: "emb-false-positive",
            rootAttemptId: "r7",
            chapterId: "ch-3",
            localDate: "2026-11-07",
            excerpt: "Correctly solved: -2x <= 8 => x >= -4",
          }),
        },
      ],
    });

    expect(result.status).toBe("threshold_not_met");
    expect(result.clinic).toBeNull();
    expect(result.coverage.rootAttemptCount).toBe(2);
    expect(result.rejectedCounts.assisted).toBe(1);
    expect(result.rejectedCounts.invalidPrivacyEpoch).toBe(1);
    expect(result.rejectedCounts.revokedSource).toBe(1);
    expect(result.rejectedCounts.ruleIdMismatch).toBe(1);
    expect(result.rejectedCounts.verifierRejected).toBe(1);
    expect(result.rejectedCounts.transitiveClosureBlocked).toBe(2);
  });
});

describe("RemedyClinicGenerator 14-minute 3-step clinic & #469 probe distinguishability", () => {
  const qualifyingAttempts: DiagnosedRootAttempt[] = [
    makeAttempt({ attemptId: "a1", rootAttemptId: "r1", chapterId: "ch-1", localDate: "2026-11-01" }),
    makeAttempt({ attemptId: "a2", rootAttemptId: "r2", chapterId: "ch-1", localDate: "2026-11-01" }),
    makeAttempt({ attemptId: "a3", rootAttemptId: "r3", chapterId: "ch-2", localDate: "2026-11-03" }),
    makeAttempt({ attemptId: "a4", rootAttemptId: "r4", chapterId: "ch-3", localDate: "2026-11-05" }),
  ];

  it("generates a clinic when structuredClone uses a single DataCloneError diagnostic", async () => {
    const nativeClone = globalThis.structuredClone;
    vi.stubGlobal("structuredClone", (value: unknown) => {
      try {
        return nativeClone(value);
      } catch (error) {
        if (error instanceof DOMException && error.name === "DataCloneError") {
          throw new DOMException("The object can not be cloned.", "DataCloneError");
        }
        throw error;
      }
    });

    try {
      vi.resetModules();
      const { generateRemedyClinic: generate } = await import("./clinic-generator");
      const input = {
        learnerId: "learner-1",
        courseId: "course-alg-1",
        ruleId: RULE_ID,
        currentPrivacyEpoch: 5,
        activeSourcesMap: DEFAULT_SOURCES,
        verifyRuleViolation: verifyNegativeSignFlip,
        attempts: qualifyingAttempts,
        candidateProbes: [
          makeProbe({ probeId: "p1", input: { a: -2, b: 8 } }),
          makeProbe({ probeId: "p2", input: { a: -3, b: 12 } }),
        ],
      };
      expect(generate(input).status).toBe("active");
      expect(generate({ ...input, attempts: new Proxy(qualifyingAttempts, {}) }).status).toBe("invalid_input");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it.each([
    { sourceId: "", sourceVersion: "v1" },
    { sourceId: "   ", sourceVersion: "v1" },
    { sourceId: "invalid-version", sourceVersion: "" },
    { sourceId: "invalid-version", sourceVersion: "   " },
    { sourceId: "invalid-version", sourceVersion: Infinity },
    { sourceId: "invalid-version", sourceVersion: NaN },
  ])("rejects invalid source reference %j even if the active map lists it", (sourceRef) => {
    const { sourceId, sourceVersion } = sourceRef;
    const activeSourcesMap = new Map<string, string | number>([
      ["src-ch-1", "v1"], ["src-ch-2", "v1"], ["src-ch-3", "v1"], [sourceId, sourceVersion],
      ["src-numeric", 0],
    ]);
    const candidateProbes = [
      makeProbe({ probeId: "p1", input: { a: -2, b: 8 } }),
      makeProbe({ probeId: "p2", input: { a: -3, b: 12 } }),
    ];
    const input = {
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: qualifyingAttempts,
      candidateProbes,
    };
    const result = generateRemedyClinic(input);
    expect(result.status).toBe("active");
    const clinic = result.clinic!;

    const numericRef = { sourceId: "src-numeric", sourceVersion: 0 };
    expect(isSourceRefActive(numericRef, activeSourcesMap)).toBe(true);
    expect(generateRemedyClinic({ ...input, ruleSourceRefs: [numericRef] }).status).toBe("active");
    expect(isSourceRefActive(sourceRef, activeSourcesMap)).toBe(false);
    expect(inspectActiveSourcesMap(activeSourcesMap).sources.has(sourceId)).toBe(false);
    expect(inspectActiveSourcesMap(Object.fromEntries(activeSourcesMap)).sources.has(sourceId)).toBe(false);
    expect(generateRemedyClinic({ ...input, ruleSourceRefs: [sourceRef] }).status).toBe("invalid_input");
    expect(generateRemedyClinic({
      ...input,
      candidateProbes: [
        { ...makeProbe({ probeId: "blank-source", input: { a: -4, b: 16 } }), sourceRefs: [sourceRef] },
        ...candidateProbes,
      ],
    })).toMatchObject({
      status: "active",
      verifiedProbeCount: 2,
      rejectedProbes: [expect.objectContaining({ probeId: "blank-source" })],
    });

    expect(revalidateRemedyClinic({ ...clinic, ruleSourceRefs: [sourceRef] }, activeSourcesMap, 5)).toMatchObject({
      status: "stale_source_revoked",
      revocationSummary: { reason: "rule_source_revoked" },
    });
    const [step1, step2, step3] = clinic.steps;
    const probes = [{ ...step3.probes[0]!, sourceRefs: [sourceRef] }, ...step3.probes.slice(1)];
    expect(revalidateRemedyClinic({
      ...clinic,
      steps: [step1, step2, { ...step3, probes }],
    }, activeSourcesMap, 5).status).toBe("stale_source_revoked");
  });

  it("rejects unsafe descriptors and callable Proxies before filtering probes", () => {
    const valid1 = makeProbe({ probeId: "valid-1", input: { a: -2, b: 8 } });
    const valid2 = makeProbe({ probeId: "valid-2", input: { a: -3, b: 12 } });
    const candidateProbes = [
      { probeId: "incomplete", evaluate: null } as unknown as typeof valid1,
      valid1,
      valid2,
    ];
    const input = {
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: DEFAULT_SOURCES,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: qualifyingAttempts,
      candidateProbes,
    };

    const normal = generateRemedyClinic(input);
    expect(normal.status).toBe("active");
    expect(normal.verifiedProbeCount).toBe(2);
    expect(generateRemedyClinic({
      ...input,
      candidateProbes: [
        makeProbe({ probeId: "degenerate", input: { a: -4, b: 16 }, degenerate: true }),
        valid1,
        valid2,
      ],
    })).toMatchObject({
      status: "active",
      verifiedProbeCount: 2,
      rejectedProbes: [expect.objectContaining({ probeId: "degenerate", reason: "not_distinguishable" })],
    });
    let getterRuns = 0;
    const unread = () => {
      getterRuns += 1;
      throw new Error("Ordinary property read");
    };
    const getterCallback = Object.defineProperty(() => true, Symbol.toStringTag, { get: unread });
    const accessorDescriptor = new Proxy(input, {
      get: unread,
      getOwnPropertyDescriptor(target, key) {
        if (key === "verifyRuleViolation") return { enumerable: true, configurable: true, get: unread };
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const inconsistentLength = new Proxy(candidateProbes, {
      get: unread,
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        return key === "length" ? { ...descriptor, value: 10 } : descriptor;
      },
    });
    const invalidKeys = new Proxy(valid1, {
      get: unread,
      ownKeys(target) {
        return [...Reflect.ownKeys(target), Symbol("unexpected")];
      },
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === "symbol") return { value: true, enumerable: true, configurable: true };
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    for (const invalid of [
      accessorDescriptor,
      new Proxy(input, { get: unread, getPrototypeOf: () => null }),
      { ...input, candidateProbes: inconsistentLength },
      { ...input, candidateProbes: [candidateProbes[0]!, invalidKeys, valid2] },
      { ...input, verifyRuleViolation: new Proxy(verifyNegativeSignFlip, { get: unread, apply: unread }) },
      { ...input, verifyRuleViolation: getterCallback },
      { ...input, candidateProbes: [{ ...valid1, input: new Proxy(valid1.input, {}) }, ...candidateProbes] },
      { ...input, rubricCalibration: new Proxy({ calibrated: true }, {}) },
      { ...input, ruleSourceRefs: new Proxy([{ sourceId: "src-ch-1", sourceVersion: "v1" }], {}) },
    ]) {
      expect(generateRemedyClinic(invalid)).toMatchObject({ status: "invalid_input", clinic: null });
    }

    const wrappedCarriers = new Proxy({
      ...input,
      candidateProbes: new Proxy([
        candidateProbes[0]!,
        new Proxy(valid1, { get: unread }),
        valid2,
      ], { get: unread }),
    }, { get: unread });
    expect(generateRemedyClinic(wrappedCarriers).status).toBe("active");
    expect(getterRuns).toBe(0);
  });

  it.each([1, 2])("rejects shared probe data without reading a getter added on descriptor read %i", (mutationRead) => {
    const valid1 = makeProbe({ probeId: "valid-1", input: { a: -2, b: 8 } });
    const valid2 = makeProbe({ probeId: "valid-2", input: { a: -3, b: 12 } });
    const sibling = { label: "shared" };
    let descriptorReads = 0;
    let getterRuns = 0;
    const middle = new Proxy({ marker: true }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "marker" && ++descriptorReads === mutationRead) {
          Object.defineProperty(sibling, "added", {
            enumerable: true,
            configurable: true,
            get() {
              getterRuns += 1;
              return "unread";
            },
          });
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const result = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: DEFAULT_SOURCES,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: qualifyingAttempts,
      candidateProbes: [
        { ...valid1, input: { ...valid1.input, aRef: sibling, bRef: middle, cRef: { ref: sibling } } },
        valid1,
        valid2,
      ],
    });
    expect(descriptorReads).toBe(mutationRead);
    expect(getterRuns).toBe(0);
    expect(result).toMatchObject({ status: "invalid_input", clinic: null });
  });

  it("validates the coverage graph before skipping incomplete rows", () => {
    const zeroCoverage = { rootAttemptCount: 0, chapterCount: 0, localDateCount: 0 };
    const rows = [null, 123, { attemptId: "" }, ...qualifyingAttempts.slice(1)] as unknown as typeof qualifyingAttempts;
    expect(computeEvidenceCoverage(rows)).toEqual({ rootAttemptCount: 3, chapterCount: 3, localDateCount: 3 });
    expect(computeEvidenceCoverage(new Proxy(rows, {}))).toEqual(zeroCoverage);
    expect(computeEvidenceCoverage([new Proxy(rows[2]!, {}), ...rows])).toEqual(zeroCoverage);
    const cycle: { ref?: object } = {};
    cycle.ref = cycle;
    expect(computeEvidenceCoverage([...rows, { ...qualifyingAttempts[0]!, extra: cycle }])).toEqual(zeroCoverage);

    let getterRuns = 0;
    const withGetter = {
      ...qualifyingAttempts[0]!,
      extra: {
        get unread() {
          getterRuns += 1;
          return true;
        },
      },
    };
    expect(computeEvidenceCoverage([...rows, withGetter])).toEqual(zeroCoverage);
    expect(getterRuns).toBe(0);
  });

  it("captures Map entries before inspecting descriptor traps and rejects mutations", () => {
    const sources = new Map<string, { version: string }>();
    let descriptorReads = 0;
    const growingEntry = (): { version: string } => new Proxy({ version: "v1" }, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "version" && ++descriptorReads <= 4) {
          sources.set(`added-${descriptorReads}`, growingEntry());
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    sources.set("src-ch-1", growingEntry());
    expect(inspectActiveSourcesMap(sources)).toEqual({ containerValid: false, sources: new Map() });
    expect(descriptorReads).toBeLessThan(4);
  });

  it("rejects a Map that exceeds the active source entry limit", () => {
    const sources = new Map<string, string>();
    for (let i = 0; i <= 10_000; i += 1) sources.set(String(i), "v1");
    expect(inspectActiveSourcesMap(sources)).toEqual({ containerValid: false, sources: new Map() });
  });

  it("emits a 14m 3-step clinic maximizing chapter/day spread and keeping Step 2 free of probe leaks", () => {
    const probes = [
      makeProbe({ probeId: "probe-transfer-1", input: { a: -2, b: 8 } }),
      makeProbe({ probeId: "probe-transfer-2", input: { a: -5, b: 20 } }),
    ];

    const result = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      ruleTitle: "Negative Division Inequality Flip",
      currentPrivacyEpoch: 5,
      activeSourcesMap: DEFAULT_SOURCES,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: qualifyingAttempts,
      candidateProbes: probes,
    });

    expect(result.status).toBe("active");
    expect(result.clinic).not.toBeNull();
    const clinic = result.clinic!;

    expect(clinic.totalMinutes).toBe(14);
    expect(clinic.steps[0].kind).toBe("side_by_side_self_diff");
    expect(clinic.steps[0].durationMinutes).toBe(4);
    expect(clinic.steps[0].selectedCases).toHaveLength(3);
    expect(new Set(clinic.steps[0].selectedCases.map((c) => c.chapterId)).size).toBe(3);
    expect(new Set(clinic.steps[0].selectedCases.map((c) => c.localDate)).size).toBe(3);

    expect(clinic.steps[1].kind).toBe("invariant_rule_restatement");
    expect(clinic.steps[1].durationMinutes).toBe(3);
    expect(clinic.steps[1].ruleId).toBe(RULE_ID);
    expect(clinic.steps[1].prompt).not.toContain("probe-transfer-1");
    expect(clinic.steps[1].prompt).not.toContain("x >= -4");

    expect(clinic.steps[2].kind).toBe("distinguishable_transfer_probes");
    expect(clinic.steps[2].durationMinutes).toBe(7);
    expect(clinic.steps[2].probes).toHaveLength(2);
    expect(clinic.steps[2].probes.every((probe) => probe.report.distinguishable)).toBe(true);
  });

  it("fails closed with insufficient_distinguishable_probes when degenerate, ambiguous, or duplicate probes leave < 2 valid", () => {
    const goodProbe = makeProbe({ probeId: "probe-good", input: { a: -2, b: 8 } });
    const degenerateProbe = makeProbe({ probeId: "probe-degenerate", input: { a: -2, b: 8 }, degenerate: true });
    const ambiguousProbe = makeProbe({ probeId: "probe-ambiguous", input: { a: -4, b: 16 }, ambiguousHypotheses: true });

    const result = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: DEFAULT_SOURCES,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: qualifyingAttempts,
      candidateProbes: [goodProbe, goodProbe, degenerateProbe, ambiguousProbe],
    });

    expect(result.status).toBe("insufficient_distinguishable_probes");
    expect(result.clinic).toBeNull();
    expect(result.verifiedProbeCount).toBe(1);
    expect(result.rejectedProbes).toHaveLength(3);
    expect(result.rejectedProbes.map((p) => p.reason)).toEqual([
      "duplicate_probe_id",
      "not_distinguishable",
      "not_distinguishable",
    ]);
  });

  it("rejects distinct probeIds that share identical normalized prompt text", () => {
    const first = makeProbe({ probeId: "probe-a", input: { a: -2, b: 8 } });
    const clonePrompt: DistinguishableProbeSpec<InequalityInput, string> = {
      ...makeProbe({ probeId: "probe-b", input: { a: -2, b: 8 } }),
      prompt: `  ${first.prompt.toUpperCase()}  `,
    };

    const result = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: DEFAULT_SOURCES,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: qualifyingAttempts,
      candidateProbes: [first, clonePrompt],
    });

    expect(result.status).toBe("insufficient_distinguishable_probes");
    expect(result.clinic).toBeNull();
    expect(result.verifiedProbeCount).toBe(1);
    expect(result.rejectedProbes).toHaveLength(1);
    expect(result.rejectedProbes[0]!.reason).toBe("duplicate_probe_prompt");
  });

  it("preserves >=2 chapters and >=2 days in selectedCases even with 37-root single-chapter or single-day prefixes", () => {
    const probes = [
      makeProbe({ probeId: "probe-spread-1", input: { a: -2, b: 8 } }),
      makeProbe({ probeId: "probe-spread-2", input: { a: -3, b: 12 } }),
    ];

    const addDays = (offset: number): string => {
      const dt = new Date(Date.UTC(2026, 9, 1 + offset));
      return dt.toISOString().slice(0, 10);
    };

    // Counterexample A: 36 roots in ch-1 across 36 days + root 37 in ch-2 on day 37.
    const singleChapterPrefix: DiagnosedRootAttempt[] = Array.from({ length: 36 }, (_, idx) =>
      makeAttempt({
        attemptId: `sc-a-${idx}`,
        rootAttemptId: `sc-r-${idx}`,
        chapterId: "ch-1",
        localDate: addDays(idx),
        sourceRefs: [{ sourceId: "src-ch-1", sourceVersion: "v1" }],
      }),
    );
    singleChapterPrefix.push(
      makeAttempt({
        attemptId: "sc-a-36",
        rootAttemptId: "sc-r-36",
        chapterId: "ch-2",
        localDate: addDays(36),
        sourceRefs: [{ sourceId: "src-ch-2", sourceVersion: "v1" }],
      }),
    );

    const resA = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: DEFAULT_SOURCES,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: singleChapterPrefix,
      candidateProbes: probes,
    });
    expect(resA.status).toBe("active");
    const step1A = resA.clinic!.steps[0];
    expect(step1A.selectedCases).toHaveLength(3);
    expect(new Set(step1A.selectedCases.map((c) => c.chapterId)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(step1A.selectedCases.map((c) => c.localDate)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(step1A.diffs.map((d) => d.chapterId)).size).toBeGreaterThanOrEqual(2);

    // Counterexample B: 36 roots on day 1 across 18 chapters x 2 + root 37 on day 2.
    const manySources: Record<string, string> = {};
    const singleDayPrefix: DiagnosedRootAttempt[] = [];
    for (let ch = 1; ch <= 18; ch++) {
      const chapterId = `ch-${String(ch).padStart(2, "0")}`;
      const sourceId = `src-${chapterId}`;
      manySources[sourceId] = "v1";
      for (let copy = 0; copy < 2; copy++) {
        singleDayPrefix.push(
          makeAttempt({
            attemptId: `sd-a-${ch}-${copy}`,
            rootAttemptId: `sd-r-${ch}-${copy}`,
            chapterId,
            localDate: "2026-11-01",
            sourceRefs: [{ sourceId, sourceVersion: "v1" }],
          }),
        );
      }
    }
    singleDayPrefix.push(
      makeAttempt({
        attemptId: "sd-a-day2",
        rootAttemptId: "sd-r-day2",
        chapterId: "ch-01",
        localDate: "2026-11-02",
        sourceRefs: [{ sourceId: "src-ch-01", sourceVersion: "v1" }],
      }),
    );

    const resB = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: manySources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: singleDayPrefix,
      candidateProbes: probes,
    });
    expect(resB.status).toBe("active");
    const step1B = resB.clinic!.steps[0];
    expect(step1B.selectedCases).toHaveLength(3);
    expect(new Set(step1B.selectedCases.map((c) => c.chapterId)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(step1B.selectedCases.map((c) => c.localDate)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(step1B.diffs.map((d) => d.localDate)).size).toBeGreaterThanOrEqual(2);
  });
});

describe("revalidateRemedyClinic privacy_epoch and source-revocation read guard", () => {
  const probes = [
    makeProbe({ probeId: "probe-1", input: { a: -2, b: 8 } }),
    makeProbe({ probeId: "probe-2", input: { a: -3, b: 12 } }),
  ];

  const allCaseSources = {
    "src-revokable": "v1",
    "src-ch-1": "v1",
    "src-ch-2": "v1",
    "src-ch-3": "v1",
  };

  function createFourCaseClinic(privacyEpoch = 5) {
    const generated = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: privacyEpoch,
      activeSourcesMap: allCaseSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      candidateProbes: probes,
      attempts: [
        makeAttempt({
          attemptId: "a1",
          rootAttemptId: "r-revoked",
          chapterId: "ch-1",
          localDate: "2026-11-01",
          excerpt: "TOP_SECRET_REVOKED_TEXT: -2x <= 8 => x <= -4",
          sourceRefs: [{ sourceId: "src-revokable", sourceVersion: "v1" }],
        }),
        makeAttempt({
          attemptId: "a2",
          rootAttemptId: "r-keep-1",
          chapterId: "ch-1",
          localDate: "2026-11-02",
          sourceRefs: [{ sourceId: "src-ch-1", sourceVersion: "v1" }],
        }),
        makeAttempt({
          attemptId: "a3",
          rootAttemptId: "r-keep-2",
          chapterId: "ch-2",
          localDate: "2026-11-04",
          sourceRefs: [{ sourceId: "src-ch-2", sourceVersion: "v1" }],
        }),
        makeAttempt({
          attemptId: "a4",
          rootAttemptId: "r-keep-3",
          chapterId: "ch-3",
          localDate: "2026-11-06",
          sourceRefs: [{ sourceId: "src-ch-3", sourceVersion: "v1" }],
        }),
      ].map((attempt) => ({ ...attempt, privacyEpoch })),
    });
    expect(generated.status).toBe("active");
    return generated.clinic!;
  }

  it("strips evidence from before the clinic's creation epoch, even when its source is active", () => {
    const clinic = createFourCaseClinic(2);
    const mixedEpochCases = clinic.evidenceCases.map((item) =>
      item.rootAttemptId === "r-revoked" ? { ...item, privacyEpoch: 1 } : item,
    );

    const threeCases = mixedEpochCases.filter((item) => item.rootAttemptId !== "r-keep-3");
    const revoked = revalidateRemedyClinic({ ...clinic, evidenceCases: threeCases }, allCaseSources, 2);
    expect(revoked.status).toBe("stale_source_revoked");
    expect(revoked.revocationSummary).toEqual({
      reason: "insufficient_surviving_evidence",
      strippedCaseCount: 1,
    });
    expect(revoked.coverage.rootAttemptCount).toBe(2);
    expect(revoked.evidenceCases).toEqual([]);
    expect(revoked.steps[0].selectedCases).toEqual([]);
    expect(revoked.steps[0].diffs).toEqual([]);

    const active = revalidateRemedyClinic({ ...clinic, evidenceCases: mixedEpochCases }, allCaseSources, 3);
    const survivingRootIds = ["r-keep-1", "r-keep-2", "r-keep-3"];
    expect(active.status).toBe("active");
    expect(active.revocationSummary.strippedCaseCount).toBe(1);
    expect(active.evidenceCases.map((item) => item.rootAttemptId)).toEqual(survivingRootIds);
    expect(active.steps[0].selectedCases.map((item) => item.rootAttemptId)).toEqual(survivingRootIds);
    expect(active.steps[0].diffs.map((item) => item.rootAttemptId)).toEqual(survivingRootIds);
    expect(JSON.stringify(active)).not.toContain("TOP_SECRET_REVOKED_TEXT");
  });

  it("keeps creation-epoch evidence when revalidating against a later epoch with active sources", () => {
    const clinic = createFourCaseClinic(2);
    const revalidated = revalidateRemedyClinic(clinic, allCaseSources, 3);

    expect(revalidated).toMatchObject({
      status: "active",
      createdPrivacyEpoch: 2,
      validatedPrivacyEpoch: 3,
      revocationSummary: { reason: "none", strippedCaseCount: 0 },
    });
    expect(revalidated.evidenceCases).toEqual(clinic.evidenceCases);
    expect(revalidated.steps[0].diffs).toEqual(clinic.steps[0].diffs);
  });

  it("strips revoked cases with zero remaining excerpt text and stays active when surviving cases preserve >=3x>=2x>=2", () => {
    const clinic = createFourCaseClinic();

    const revalidated = revalidateRemedyClinic(
      clinic,
      {
        "src-ch-1": "v1",
        "src-ch-2": "v1",
        "src-ch-3": "v1",
      },
      6,
    );

    expect(revalidated.status).toBe("active");
    expect(revalidated.createdPrivacyEpoch).toBe(5);
    expect(revalidated.validatedPrivacyEpoch).toBe(6);
    expect(revalidated.coverage).toEqual({ rootAttemptCount: 3, chapterCount: 3, localDateCount: 3 });
    expect(revalidated.steps[0].selectedCases).toHaveLength(3);
    expect(revalidated.revocationSummary).toEqual({
      strippedCaseCount: 1,
      reason: "partial_source_revoked_still_active",
    });
    expect(JSON.stringify(revalidated)).not.toContain("TOP_SECRET_REVOKED_TEXT");
    expect(JSON.stringify(revalidated)).not.toContain("r-revoked");
  });

  it("preserves prior case revocation on revalidation at the same epoch and accumulates a later removal", () => {
    const clinic = createFourCaseClinic();
    const survivingSources = { "src-ch-1": "v1", "src-ch-2": "v1", "src-ch-3": "v1" };
    const partiallyRevoked = revalidateRemedyClinic(clinic, survivingSources, 5);
    expect(partiallyRevoked).toMatchObject({
      status: "active",
      revocationSummary: { reason: "partial_source_revoked_still_active", strippedCaseCount: 1 },
    });
    const revalidatedAgain = revalidateRemedyClinic(partiallyRevoked, survivingSources, 5);
    expect(revalidatedAgain).toEqual(partiallyRevoked);
    const markerOnly = { ...partiallyRevoked, revocationSummary: { ...partiallyRevoked.revocationSummary, strippedCaseCount: 0 } };
    expect(revalidateRemedyClinic(markerOnly, survivingSources, 5).revocationSummary).toEqual(markerOnly.revocationSummary);

    const next = revalidateRemedyClinic(revalidatedAgain, { ...survivingSources, "src-ch-1": "v2" }, 5);
    expect(next).toMatchObject({
      status: "stale_source_revoked",
      coverage: { rootAttemptCount: 2 },
      evidenceCases: [],
      revocationSummary: { reason: "insufficient_surviving_evidence", strippedCaseCount: 2 },
    });
    expect(revalidateRemedyClinic(next, allCaseSources, 5).revocationSummary).toEqual(next.revocationSummary);
  });

  it("degrades to stale_source_revoked with empty excerpts when source version mismatch or deletion breaks the threshold", () => {
    const clinic = createFourCaseClinic();

    // src-revokable deleted AND src-ch-1 bumped to v2 => only 2 surviving roots left.
    const degraded = revalidateRemedyClinic(
      clinic,
      {
        "src-ch-1": "v2",
        "src-ch-2": "v1",
        "src-ch-3": "v1",
      },
      7,
    );

    expect(degraded.status).toBe("stale_source_revoked");
    expect(degraded.validatedPrivacyEpoch).toBe(7);
    expect(degraded.coverage.rootAttemptCount).toBe(2);
    expect(degraded.evidenceCases).toEqual([]);
    expect(degraded.steps[0].selectedCases).toEqual([]);
    expect(degraded.steps[0].diffs).toEqual([]);
    expect(degraded.revocationSummary).toEqual({
      strippedCaseCount: 2,
      reason: "insufficient_surviving_evidence",
    });
    expect(JSON.stringify(degraded)).not.toContain("TOP_SECRET_REVOKED_TEXT");
    expect(JSON.stringify(degraded)).not.toContain("SECRET_EXCERPT_");
  });

  it("fails closed to stale_source_revoked when currentPrivacyEpoch regresses below createdPrivacyEpoch", () => {
    const clinic = createFourCaseClinic();
    const regressed = revalidateRemedyClinic(
      clinic,
      {
        "src-revokable": "v1",
        "src-ch-1": "v1",
        "src-ch-2": "v1",
        "src-ch-3": "v1",
      },
      4,
    );
    expect(regressed.status).toBe("stale_source_revoked");
    expect(regressed.evidenceCases).toEqual([]);
    expect(regressed.steps[0].selectedCases).toEqual([]);
    expect(regressed.revocationSummary.reason).toBe("invalid_privacy_epoch");
    expect(JSON.stringify(regressed)).not.toContain("TOP_SECRET_REVOKED_TEXT");
  });

  it("rejects validatedPrivacyEpoch rollback (7 -> 6) and strips tampered ruleId or future-epoch cases", () => {
    const clinic = createFourCaseClinic();
    const allSources = {
      "src-revokable": "v1",
      "src-ch-1": "v1",
      "src-ch-2": "v1",
      "src-ch-3": "v1",
    };

    const atEpoch7 = revalidateRemedyClinic(clinic, allSources, 7);
    expect(atEpoch7.status).toBe("active");
    expect(atEpoch7.validatedPrivacyEpoch).toBe(7);

    const rolledBack = revalidateRemedyClinic(atEpoch7, allSources, 6);
    expect(rolledBack.status).toBe("stale_source_revoked");
    expect(rolledBack.validatedPrivacyEpoch).toBe(7);
    expect(rolledBack.evidenceCases).toEqual([]);
    expect(rolledBack.steps[0].selectedCases).toEqual([]);
    expect(rolledBack.steps[0].diffs).toEqual([]);
    expect(rolledBack.revocationSummary.reason).toBe("invalid_privacy_epoch");
    expect(JSON.stringify(rolledBack)).not.toContain("TOP_SECRET_REVOKED_TEXT");

    const tampered = {
      ...clinic,
      evidenceCases: clinic.evidenceCases.map((item, idx) =>
        idx === 0
          ? { ...item, ruleId: "wrong_rule_id" }
          : idx === 1
            ? { ...item, privacyEpoch: 9 }
            : item,
      ),
    };
    const scrubbed = revalidateRemedyClinic(tampered, allSources, 6);
    expect(scrubbed.status).toBe("stale_source_revoked");
    expect(scrubbed.coverage.rootAttemptCount).toBe(2);
    expect(scrubbed.evidenceCases).toEqual([]);
    expect(scrubbed.steps[0].selectedCases).toEqual([]);
    expect(scrubbed.revocationSummary.strippedCaseCount).toBe(2);
    expect(JSON.stringify(scrubbed)).not.toContain("TOP_SECRET_REVOKED_TEXT");
  });

  it("scrubs Step 2 ruleTitle and Step 3 probes on revocation, enforces probe/rule sourceRefs, and freezes probe snapshots before predict", () => {
    const allSources = {
      "src-rule": "v1",
      "src-probe-1": "v1",
      "src-probe-2": "v1",
      "src-ch-1": "v1",
      "src-ch-2": "v1",
      "src-ch-3": "v1",
    };

    const attempts = [
      makeAttempt({ attemptId: "a1", rootAttemptId: "r1", chapterId: "ch-1", localDate: "2026-11-01" }),
      makeAttempt({ attemptId: "a2", rootAttemptId: "r2", chapterId: "ch-2", localDate: "2026-11-03" }),
      makeAttempt({ attemptId: "a3", rootAttemptId: "r3", chapterId: "ch-3", localDate: "2026-11-05" }),
    ];

    // Probe 1's predict callback tries to mutate the caller's original probe.prompt to "".
    const mutatingProbe = {
      ...makeProbe({ probeId: "probe-mutating", input: { a: -2, b: 8 } }),
      prompt: "SECRET_PROBE_PROMPT_1: Solve -2x <= 8",
      sourceRefs: [{ sourceId: "src-probe-1", sourceVersion: "v1" }],
    };
    const originalPredict = mutatingProbe.correctModel.predict;
    mutatingProbe.correctModel = {
      ...mutatingProbe.correctModel,
      predict: (input) => {
        mutatingProbe.prompt = "";
        return originalPredict(input);
      },
    };
    const probe2 = {
      ...makeProbe({ probeId: "probe-src-2", input: { a: -3, b: 12 } }),
      prompt: "SECRET_PROBE_PROMPT_2: Solve -3x <= 12",
      sourceRefs: [{ sourceId: "src-probe-2", sourceVersion: "v1" }],
    };
    const emptySourceRefProbe = {
      ...makeProbe({ probeId: "probe-empty-refs", input: { a: -4, b: 16 } }),
      prompt: "Solve -4x <= 16",
      sourceRefs: [],
    };

    const generated = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      ruleTitle: "SECRET_RULE_TITLE_NEGATIVE_FLIP",
      ruleSourceRefs: [{ sourceId: "src-rule", sourceVersion: "v1" }],
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [emptySourceRefProbe, mutatingProbe, probe2],
    });
    expect(generated.status).toBe("active");
    expect(generated.rejectedProbes).toHaveLength(1);
    expect(generated.rejectedProbes[0]!.reason).toBe("revoked_probe_source");

    const clinic = generated.clinic!;
    // Pre-verification frozen snapshot preserved original prompt despite predict mutating caller's object.
    expect(mutatingProbe.prompt).toBe("");
    expect(clinic.steps[2].probes[0]!.prompt).toBe("SECRET_PROBE_PROMPT_1: Solve -2x <= 8");
    expect(clinic.steps[1].ruleTitle).toBe("SECRET_RULE_TITLE_NEGATIVE_FLIP");

    // Revoking src-probe-1 leaves < 2 active probes => degrades and scrubs ALL 3 steps.
    const probeRevoked = revalidateRemedyClinic(
      clinic,
      {
        "src-rule": "v1",
        "src-probe-2": "v1",
        "src-ch-1": "v1",
        "src-ch-2": "v1",
        "src-ch-3": "v1",
      },
      6,
    );
    expect(probeRevoked.status).toBe("stale_source_revoked");
    expect(probeRevoked.revocationSummary.reason).toBe("insufficient_surviving_probes");
    expect(probeRevoked.steps[0].selectedCases).toEqual([]);
    expect(probeRevoked.steps[1].ruleTitle).toBe("");
    expect(probeRevoked.steps[2].probes).toEqual([]);
    expect(JSON.stringify(probeRevoked)).not.toContain("SECRET_RULE_TITLE_NEGATIVE_FLIP");
    expect(JSON.stringify(probeRevoked)).not.toContain("SECRET_PROBE_PROMPT_1");
    expect(JSON.stringify(probeRevoked)).not.toContain("SECRET_PROBE_PROMPT_2");

    // Revoking src-rule degrades immediately and scrubs ALL 3 steps.
    const ruleRevoked = revalidateRemedyClinic(
      clinic,
      {
        "src-probe-1": "v1",
        "src-probe-2": "v1",
        "src-ch-1": "v1",
        "src-ch-2": "v1",
        "src-ch-3": "v1",
      },
      6,
    );
    expect(ruleRevoked.status).toBe("stale_source_revoked");
    expect(ruleRevoked.revocationSummary.reason).toBe("rule_source_revoked");
    expect(ruleRevoked.steps[1].ruleTitle).toBe("");
    expect(ruleRevoked.steps[2].probes).toEqual([]);
    expect(JSON.stringify(ruleRevoked)).not.toContain("SECRET_RULE_TITLE_NEGATIVE_FLIP");

    // Corrupted createdPrivacyEpoch = -1 with validatedPrivacyEpoch = 7, current = 8 must NOT reset to 0.
    const corruptedEpochClinic = { ...clinic, createdPrivacyEpoch: -1, validatedPrivacyEpoch: 7 };
    const corruptedRes = revalidateRemedyClinic(corruptedEpochClinic, allSources, 8);
    expect(corruptedRes.status).toBe("stale_source_revoked");
    expect(corruptedRes.revocationSummary.reason).toBe("invalid_privacy_epoch");
    expect(corruptedRes.validatedPrivacyEpoch).toBeGreaterThanOrEqual(7);

    // Runtime null/non-object entries in ruleSourceRefs, probe.sourceRefs, and activeSourcesMap fail closed cleanly.
    const nullRef = null as unknown as { sourceId: string; sourceVersion: string };
    const nullRuleSourceRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      ruleSourceRefs: [nullRef],
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [probe2, makeProbe({ probeId: "probe-ok-extra", input: { a: -5, b: 20 } })],
    });
    expect(nullRuleSourceRes.status).toBe("invalid_input");
    expect(nullRuleSourceRes.clinic).toBeNull();

    const nullProbeSourceRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [
        { ...makeProbe({ probeId: "probe-null-ref", input: { a: -6, b: 24 } }), sourceRefs: [nullRef] },
        probe2,
      ],
    });
    expect(nullProbeSourceRes.status).toBe("insufficient_distinguishable_probes");
    expect(nullProbeSourceRes.clinic).toBeNull();
    expect(nullProbeSourceRes.rejectedProbes).toHaveLength(1);
    expect(nullProbeSourceRes.rejectedProbes[0]!.reason).toBe("revoked_probe_source");

    const nullActiveEntry = revalidateRemedyClinic(
      clinic,
      {
        ...allSources,
        "src-ch-1": null as unknown as string,
      },
      6,
    );
    expect(nullActiveEntry.status).toBe("stale_source_revoked");
    expect(nullActiveEntry.evidenceCases).toEqual([]);
    expect(nullActiveEntry.steps[0].selectedCases).toEqual([]);
    expect(nullActiveEntry.steps[2].probes).toEqual([]);

    // Sparse arrays in ruleSourceRefs and probe.sourceRefs must fail closed and never drop provenance.
    const sparseRefs = new Array<{ sourceId: string; sourceVersion: string }>(1);
    const sparseRuleRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      ruleSourceRefs: sparseRefs,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [probe2, makeProbe({ probeId: "probe-ok-2", input: { a: -5, b: 20 } })],
    });
    expect(sparseRuleRes.status).toBe("invalid_input");

    // Probe 1's predict callback mutating input.ruleSourceRefs and probe2.sourceRefs mid-run cannot strip provenance.
    const mutableProbe2: {
      sourceRefs?: Array<{ sourceId: string; sourceVersion: string }>;
    } & ReturnType<typeof makeProbe> = {
      ...makeProbe({ probeId: "probe-2-mut-target", input: { a: -7, b: 28 } }),
      sourceRefs: [{ sourceId: "src-probe-2", sourceVersion: "v1" }],
    };
    const mutableInput: Parameters<typeof generateRemedyClinic<InequalityInput, string>>[0] = {
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      ruleTitle: "IMMUTABLE_RULE_TITLE",
      ruleSourceRefs: [{ sourceId: "src-rule", sourceVersion: "v1" }],
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [],
    };
    const hostileProbe1 = {
      ...makeProbe({ probeId: "probe-hostile-1", input: { a: -2, b: 8 } }),
      sourceRefs: [{ sourceId: "src-probe-1", sourceVersion: "v1" }],
    };
    const origHostilePredict = hostileProbe1.correctModel.predict;
    hostileProbe1.correctModel = {
      ...hostileProbe1.correctModel,
      predict: (inp) => {
        (mutableInput as { ruleSourceRefs?: unknown }).ruleSourceRefs = undefined;
        delete mutableProbe2.sourceRefs;
        return origHostilePredict(inp);
      },
    };
    (mutableInput as { candidateProbes: unknown[] }).candidateProbes = [hostileProbe1, mutableProbe2];
    const immutableRes = generateRemedyClinic(mutableInput);
    expect(immutableRes.status).toBe("active");
    expect(immutableRes.clinic!.ruleSourceRefs).toEqual([{ sourceId: "src-rule", sourceVersion: "v1" }]);
    expect(immutableRes.clinic!.steps[2].probes[1]!.sourceRefs).toEqual([
      { sourceId: "src-probe-2", sourceVersion: "v1" },
    ]);

    // Enumerable getter on probe.input must be rejected BEFORE structuredClone without invoking the getter.
    let getterInvoked = false;
    const getterInput = Object.defineProperty({ b: 8 }, "a", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return -2;
      },
    }) as unknown as InequalityInput;
    const getterProbe = {
      ...makeProbe({ probeId: "probe-getter-input", input: { a: -2, b: 8 } }),
      input: getterInput,
    };
    const getterRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [getterProbe, probe2],
    });
    expect(getterInvoked).toBe(false);
    expect(getterRes).toMatchObject({ status: "invalid_input", clinic: null });

    // Partial probe revocation leaving >= 2 surviving probes must report partial_source_revoked_still_active.
    const thirdProbe = {
      ...clinic.steps[2].probes[1]!,
      probeId: "probe-extra-revoked",
      sourceRefs: [{ sourceId: "src-probe-revoked-extra", sourceVersion: "v1" }],
    };
    const threeProbeClinic = {
      ...clinic,
      steps: [
        clinic.steps[0],
        clinic.steps[1],
        { ...clinic.steps[2], probes: [...clinic.steps[2].probes, thirdProbe] },
      ] as typeof clinic.steps,
    };
    const partialProbeReval = revalidateRemedyClinic(threeProbeClinic, allSources, 6);
    expect(partialProbeReval.status).toBe("active");
    expect(partialProbeReval.steps[2].probes).toHaveLength(2);
    expect(partialProbeReval.revocationSummary.strippedCaseCount).toBe(0);
    expect(partialProbeReval.revocationSummary.strippedProbeCount).toBe(1);
    expect(partialProbeReval.revocationSummary.reason).toBe("partial_source_revoked_still_active");
    const repeatedProbeReval = revalidateRemedyClinic(partialProbeReval, allSources, 6);
    expect(repeatedProbeReval).toEqual(partialProbeReval);
    const probesRevoked = revalidateRemedyClinic(repeatedProbeReval, { ...allSources, "src-probe-1": "v2" }, 6);
    expect(probesRevoked).toMatchObject({
      status: "stale_source_revoked",
      revocationSummary: { reason: "insufficient_surviving_probes", strippedCaseCount: 0, strippedProbeCount: 2 },
    });
    expect(revalidateRemedyClinic(probesRevoked, allSources, 6).revocationSummary).toEqual(probesRevoked.revocationSummary);

    // Step 2 learner-facing prompt must not leak internal snake_case ruleId.
    expect(clinic.steps[1].ruleId).toBe(RULE_ID);
    expect(clinic.steps[1].prompt).not.toContain(RULE_ID);
    const untitledRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [probe2, makeProbe({ probeId: "probe-untitled-2", input: { a: -5, b: 20 } })],
    });
    expect(untitledRes.status).toBe("active");
    expect(untitledRes.clinic!.steps[1].prompt).not.toContain(RULE_ID);

    // verifyRuleViolation attempting to mutate attempt.sourceRefs cannot tamper with frozen provenance.
    const mutAttempts = attempts.map((item) => ({
      ...item,
      sourceRefs: item.sourceRefs.map((r) => ({ ...r })),
    }));
    const mutatingVerifierRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: (attempt) => {
        try {
          (attempt.sourceRefs as Array<{ sourceId: string; sourceVersion: string }>)[0] = {
            sourceId: "src-ch-3",
            sourceVersion: "v1",
          };
        } catch {
          // Expected TypeError on frozen sourceRefs; still return true.
        }
        return verifyNegativeSignFlip(attempt);
      },
      attempts: mutAttempts,
      candidateProbes: [probe2, makeProbe({ probeId: "probe-mut-ver-2", input: { a: -5, b: 20 } })],
    });
    expect(mutatingVerifierRes.status).toBe("active");
    expect(mutatingVerifierRes.clinic!.evidenceCases[0]!.sourceRefs).toEqual([
      { sourceId: "src-ch-1", sourceVersion: "v1" },
    ]);

    // Probe 1 predict mutating shared hypothesis receiver state (this.config.answer) cannot affect Probe 2.
    const sharedConfig = { answer: "x <= -4" };
    interface ConfigModel {
      id: string;
      label: string;
      role: "misconception";
      description: string;
      config: { answer: string };
      predict(this: { config: { answer: string } }, input: InequalityInput): string;
    }
    const baseProbeA = makeProbe({ probeId: "probe-shared-a", input: { a: -2, b: 8 } });
    const baseProbeB = makeProbe({ probeId: "probe-shared-b", input: { a: -3, b: 12 } });
    const mutatingProbeA = {
      ...baseProbeA,
      correctModel: {
        ...baseProbeA.correctModel,
        predict: (inp: InequalityInput) => {
          sharedConfig.answer = "x >= -4";
          return baseProbeA.correctModel.predict(inp);
        },
      },
    };
    const receiverHypB: ConfigModel = {
      id: RULE_ID,
      label: "Receiver-backed hypothesis",
      role: "misconception",
      description: "Reads answer from isolated receiver config.",
      config: sharedConfig,
      predict() {
        return this.config.answer;
      },
    };
    const isolatedProbeB: DistinguishableProbeSpec<InequalityInput, string> = {
      ...baseProbeB,
      hypotheses: [receiverHypB, baseProbeB.hypotheses[1]!],
    };
    const receiverRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [mutatingProbeA, isolatedProbeB],
    });
    expect(sharedConfig.answer).toBe("x >= -4");
    expect(receiverRes.status).toBe("active");
    expect(receiverRes.clinic!.steps[2].probes).toHaveLength(2);

    // Array-slot getters at index 0 on candidateProbes, hypotheses, and ruleSourceRefs fail closed without executing.
    let slotGetterCalls = 0;
    const getterProbesArr: Array<DistinguishableProbeSpec<InequalityInput, string>> = new Array(1);
    Object.defineProperty(getterProbesArr, "0", {
      enumerable: true,
      get() {
        slotGetterCalls++;
        return probe2;
      },
    });
    const slotProbeRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: getterProbesArr,
    });
    expect(slotProbeRes.status).toBe("invalid_input");

    const getterHypArr: Array<DistinguishableProbeSpec<InequalityInput, string>["hypotheses"][number]> = new Array(1);
    Object.defineProperty(getterHypArr, "0", {
      enumerable: true,
      get() {
        slotGetterCalls++;
        return probe2.hypotheses[0]!;
      },
    });
    const slotHypRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [{ ...probe2, probeId: "probe-slot-hyp", hypotheses: getterHypArr }, makeProbe({ probeId: "probe-slot-ok", input: { a: -5, b: 20 } })],
    });
    expect(slotHypRes).toMatchObject({ status: "invalid_input", clinic: null });

    const getterRuleRefs: Array<{ sourceId: string; sourceVersion: string }> = new Array(1);
    Object.defineProperty(getterRuleRefs, "0", {
      enumerable: true,
      get() {
        slotGetterCalls++;
        return { sourceId: "src-rule", sourceVersion: "v1" };
      },
    });
    const slotRuleRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      ruleSourceRefs: getterRuleRefs,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [probe2, makeProbe({ probeId: "probe-slot-rule-2", input: { a: -5, b: 20 } })],
    });
    expect(slotRuleRes.status).toBe("invalid_input");
    expect(slotGetterCalls).toBe(0);

    // A shared diamond remains valid. A back edge invalidates the input graph.
    interface GraphInput {
      a: number;
      b: number;
      left?: GraphInput;
      right?: GraphInput;
      self?: GraphInput;
    }
    let diamond: GraphInput = { a: -2, b: 8 };
    for (let depth = 0; depth < 35; depth += 1) {
      diamond = { a: -2, b: 8, left: diamond, right: diamond };
    }
    const cyclic: GraphInput = { a: -3, b: 12 };
    cyclic.self = cyclic;

    const makeGraphProbe = (probeId: string, graphInput: GraphInput): ClinicCandidateProbe<GraphInput, string> => ({
      probeId,
      requirementKey: "alg.linear-inequalities",
      prompt: `Graph solve ${graphInput.a}x <= ${graphInput.b}`,
      targetMisconceptionId: RULE_ID,
      input: graphInput,
      correctModel: { id: "M_star", label: "Flip", role: "correct", predict: (x) => `x >= ${x.b / x.a}` },
      hypotheses: [
        { id: RULE_ID, label: "No flip", role: "misconception", description: "No flip", predict: (x) => `x <= ${x.b / x.a}` },
        { id: "rhs_abs", label: "Abs", role: "misconception", description: "Abs", predict: (x) => `x <= ${x.b / Math.abs(x.a)}` },
      ],
      observableKey: (s) => s,
      parseResponse: (r) => (typeof r === "string" ? r : null),
    });

    const graphInput = {
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [
        makeGraphProbe("probe-diamond-35", diamond),
        makeGraphProbe("probe-diamond-shared", { ...diamond, a: -3, b: 12 }),
      ],
    };
    const graphRes = generateRemedyClinic(graphInput);
    expect(graphRes.status).toBe("active");
    expect(graphRes.clinic!.steps[2].probes).toHaveLength(2);
    expect(generateRemedyClinic({
      ...graphInput,
      candidateProbes: [...graphInput.candidateProbes, makeGraphProbe("probe-cyclic-self", cyclic)],
    })).toMatchObject({ status: "invalid_input", clinic: null });

    // Round-7 [P1-1]: Reassigned-prototype Map with getter entry must be rejected without running the getter.
    let exoticMapGetterRan = false;
    const exoticMap = new Map<string, unknown>();
    const mapEntryVal = Object.defineProperty({}, "trap", {
      enumerable: true,
      get() {
        exoticMapGetterRan = true;
        return "mutated";
      },
    });
    exoticMap.set("k", mapEntryVal);
    Object.setPrototypeOf(exoticMap, Object.prototype);
    const exoticMapProbe = {
      ...makeProbe({ probeId: "probe-exotic-map", input: { a: -2, b: 8 } }),
      input: { a: -2, b: 8, hidden: exoticMap } as unknown as InequalityInput,
    };
    const exoticRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [exoticMapProbe, probe2],
    });
    expect(exoticMapGetterRan).toBe(false);
    expect(exoticRes).toMatchObject({ status: "invalid_input", clinic: null });

    // Round-9 [P1-4]: Own enumerable "__proto__" data property on hypothesis receiver or probe input
    // MUST invalidate the input before predict runs.
    let protoPredictCalled = false;
    const protoHyp = {
      id: RULE_ID,
      label: "Own __proto__ hypothesis",
      role: "misconception" as const,
      description: "Carries forbidden own __proto__ property.",
      predict() {
        protoPredictCalled = true;
        return "x >= -4";
      },
    };
    Object.defineProperty(protoHyp, "__proto__", {
      value: { fallback: "x >= -4" },
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const protoProbeBase = makeProbe({ probeId: "probe-own-proto", input: { a: -2, b: 8 } });
    const protoDegenerateProbe: DistinguishableProbeSpec<InequalityInput, string> = {
      ...protoProbeBase,
      hypotheses: [protoHyp, protoProbeBase.hypotheses[1]!],
    };
    const protoRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [protoDegenerateProbe, probe2],
    });
    expect(protoPredictCalled).toBe(false);
    expect(protoRes).toMatchObject({ status: "invalid_input", clinic: null });

    // Round-7 [P1-3]: observableKey receives the canonical frozen probe as `this` (reads this.requirementKey).
    const roundingProbe: ClinicCandidateProbe<InequalityInput, number> = {
      probeId: "probe-receiver-observable-key",
      requirementKey: "round.int",
      prompt: "Round-based collision probe",
      targetMisconceptionId: RULE_ID,
      input: { a: -2, b: 8 },
      correctModel: { id: "M_star", label: "Correct", role: "correct", predict: () => 1.1 },
      hypotheses: [
        { id: RULE_ID, label: "Collides when rounded", role: "misconception", description: "1.2 rounds to 1", predict: () => 1.2 },
        { id: "other_hyp", label: "Distinct", role: "misconception", description: "Distinct", predict: () => 3.0 },
      ],
      observableKey(this: { requirementKey?: string }, obs: number) {
        return this?.requirementKey === "round.int" ? String(Math.round(obs)) : String(obs);
      },
      parseResponse: (r) => (typeof r === "number" ? r : null),
    };
    const receiverKeyRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [
        roundingProbe,
        {
          ...roundingProbe,
          probeId: "probe-receiver-distinct",
          prompt: "Distinct rounding probe",
          hypotheses: [
            { id: RULE_ID, label: "Distinct 2.0", role: "misconception", description: "2.0", predict: () => 2.0 },
            { id: "other_hyp", label: "Distinct 3.0", role: "misconception", description: "3.0", predict: () => 3.0 },
          ],
        },
      ],
    });
    expect(receiverKeyRes.status).toBe("insufficient_distinguishable_probes");
    expect(receiverKeyRes.rejectedProbes[0]!.reason).toBe("not_distinguishable");

    // Round-7 [P1-4] & [P2-1]: Published clinic/evidenceCases/sourceRefs are deeply frozen, and
    // revalidateRemedyClinic rejects stateful sourceRefs getters & steps/competingModelIds index getters.
    expect(Object.isFrozen(clinic)).toBe(true);
    expect(Object.isFrozen(clinic.evidenceCases)).toBe(true);
    expect(Object.isFrozen(clinic.evidenceCases[0])).toBe(true);
    expect(Object.isFrozen(clinic.evidenceCases[0]!.sourceRefs)).toBe(true);
    expect(Object.isFrozen(clinic.evidenceCases[0]!.sourceRefs[0])).toBe(true);

    let flipGetterReads = 0;
    const flippingCase = { ...clinic.evidenceCases[0]! };
    Object.defineProperty(flippingCase, "sourceRefs", {
      enumerable: true,
      get() {
        flipGetterReads++;
        return flipGetterReads === 1
          ? [{ sourceId: "src-ch-1", sourceVersion: "v1" }]
          : [{ sourceId: "src-revoked-secret", sourceVersion: "v1" }];
      },
    });
    const flipClinic = {
      ...clinic,
      evidenceCases: [flippingCase, clinic.evidenceCases[1]!, clinic.evidenceCases[2]!],
    };
    const flipReval = revalidateRemedyClinic(flipClinic, allSources, 6);
    expect(flipGetterReads).toBe(0);
    expect(flipReval.status).toBe("stale_source_revoked");

    let stepIndexGetterCalls = 0;
    const getterSteps = new Array(3);
    Object.defineProperty(getterSteps, "0", {
      enumerable: true,
      get() {
        stepIndexGetterCalls++;
        return clinic.steps[0];
      },
    });
    getterSteps[1] = clinic.steps[1];
    getterSteps[2] = clinic.steps[2];
    const stepGetterReval = revalidateRemedyClinic(
      { ...clinic, steps: getterSteps as unknown as typeof clinic.steps },
      allSources,
      6,
    );
    expect(stepIndexGetterCalls).toBe(0);
    expect(stepGetterReval.status).toBe("stale_source_revoked");

    let competingGetterCalls = 0;
    const getterCompetingIds: string[] = new Array(2);
    Object.defineProperty(getterCompetingIds, "0", {
      enumerable: true,
      get() {
        competingGetterCalls++;
        return "M_star";
      },
    });
    getterCompetingIds[1] = RULE_ID;
    const competingGetterClinic = {
      ...clinic,
      steps: [
        clinic.steps[0],
        clinic.steps[1],
        {
          ...clinic.steps[2],
          probes: [
            { ...clinic.steps[2].probes[0]!, competingModelIds: getterCompetingIds },
            clinic.steps[2].probes[1]!,
          ],
        },
      ] as typeof clinic.steps,
    };
    const competingReval = revalidateRemedyClinic(competingGetterClinic, allSources, 6);
    expect(competingGetterCalls).toBe(0);
    expect(competingReval.status).toBe("stale_source_revoked");

    // Round-7 [P2-2]: k=20 receiver properties sharing a 35-level diamond DAG complete in O(k+V+E).
    const multiPropHyp: Record<string, unknown> = {
      id: RULE_ID,
      label: "Shared multi-prop DAG hypothesis",
      role: "misconception",
      description: "20 properties pointing to one 35-level diamond",
      predict: (x: InequalityInput) => `x <= ${x.b / x.a}`,
    };
    for (let k = 0; k < 20; k += 1) {
      multiPropHyp[`sharedDag_${k}`] = diamond;
    }
    const multiPropProbe: DistinguishableProbeSpec<InequalityInput, string> = {
      ...makeProbe({ probeId: "probe-20x-diamond", input: { a: -2, b: 8 } }),
      hypotheses: [
        multiPropHyp as unknown as DistinguishableProbeSpec<InequalityInput, string>["hypotheses"][number],
        makeProbe({ probeId: "probe-20x-ref", input: { a: -2, b: 8 } }).hypotheses[1]!,
      ],
    };
    const multiPropRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [multiPropProbe, probe2],
    });
    expect(multiPropRes.status).toBe("active");

    // Round-7 [P2-4]: ruleTitle === ruleId must NOT leak raw snake_case identifier into Step 2 prompt.
    const sameTitleAsIdRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      ruleTitle: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [probe2, makeProbe({ probeId: "probe-same-title-2", input: { a: -5, b: 20 } })],
    });
    expect(sameTitleAsIdRes.status).toBe("active");
    expect(sameTitleAsIdRes.clinic!.steps[1].ruleId).toBe(RULE_ID);
    expect(sameTitleAsIdRes.clinic!.steps[1].prompt).not.toContain(RULE_ID);
    expect(sameTitleAsIdRes.clinic!.steps[1].prompt).toContain("当前薄弱规则");

    // Round-8 [P1-1]: [Symbol.toStringTag] getter on probe input and in revalidateRemedyClinic MUST NEVER execute.
    let toStringTagCalls = 0;
    const toStringTagTrapInput = Object.defineProperty({ a: -2, b: 8 }, Symbol.toStringTag, {
      enumerable: true,
      get() {
        toStringTagCalls++;
        return "Object";
      },
    }) as unknown as InequalityInput;
    const toStringTagProbe = {
      ...makeProbe({ probeId: "probe-tostringtag-trap", input: { a: -2, b: 8 } }),
      input: toStringTagTrapInput,
    };
    const toStringTagRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [toStringTagProbe, probe2],
    });
    expect(toStringTagCalls).toBe(0);
    expect(toStringTagRes).toMatchObject({ status: "invalid_input", clinic: null });

    const toStringTagClinic = Object.defineProperty({ ...clinic }, Symbol.toStringTag, {
      enumerable: true,
      get() {
        toStringTagCalls++;
        return "Object";
      },
    }) as unknown as typeof clinic;
    const toStringTagReval = revalidateRemedyClinic(toStringTagClinic, allSources, 6);
    expect(toStringTagCalls).toBe(0);
    expect(toStringTagReval.status).toBe("stale_source_revoked");

    // Round-8 [P1-1] & [P1-2]: Prototype-reassigned Promise with [Symbol.species] getter on constructor
    // must be rejected WITHOUT executing the [Symbol.species] getter.
    let speciesGetterCalls = 0;
    const speciesCtor = Object.defineProperty({}, Symbol.species, {
      enumerable: true,
      get() {
        speciesGetterCalls++;
        return Promise;
      },
    });
    const speciesPromise = Promise.resolve("secret");
    Object.setPrototypeOf(speciesPromise, Object.prototype);
    Object.defineProperty(speciesPromise, "constructor", {
      value: speciesCtor,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const speciesPromiseProbe = {
      ...makeProbe({ probeId: "probe-species-promise", input: { a: -2, b: 8 } }),
      input: { a: -2, b: 8, leaked: speciesPromise } as unknown as InequalityInput,
    };
    const speciesPromiseRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [speciesPromiseProbe, probe2],
    });
    expect(speciesGetterCalls).toBe(0);
    expect(speciesPromiseRes).toMatchObject({ status: "invalid_input", clinic: null });

    // Round-8 [P1-2]: Prototype-reassigned Promise with constructor: null or constructor: 123 is rejected,
    // while genuine plain objects { constructor: null } and { constructor: 123 } are accepted.
    const nullCtorPromise = Promise.resolve("secret-null");
    Object.setPrototypeOf(nullCtorPromise, Object.prototype);
    Object.defineProperty(nullCtorPromise, "constructor", {
      value: null,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const numCtorPromise = Promise.resolve("secret-num");
    Object.setPrototypeOf(numCtorPromise, Object.prototype);
    Object.defineProperty(numCtorPromise, "constructor", {
      value: 123,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    for (const invalidProbe of [
      {
        ...makeProbe({ probeId: "probe-null-ctor-promise", input: { a: -2, b: 8 } }),
        input: { a: -2, b: 8, p: nullCtorPromise } as unknown as InequalityInput,
      },
      {
        ...makeProbe({ probeId: "probe-num-ctor-promise", input: { a: -3, b: 12 } }),
        input: { a: -3, b: 12, p: numCtorPromise } as unknown as InequalityInput,
      },
    ]) {
      const result = generateRemedyClinic({
        learnerId: "learner-1",
        courseId: "course-alg-1",
        ruleId: RULE_ID,
        currentPrivacyEpoch: 5,
        activeSourcesMap: allSources,
        verifyRuleViolation: verifyNegativeSignFlip,
        attempts,
        candidateProbes: [invalidProbe],
      });
      expect(result).toMatchObject({ status: "invalid_input", clinic: null });
    }

    const plainNullCtorRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [
        {
          ...makeProbe({ probeId: "probe-plain-null-ctor", input: { a: -2, b: 8 } }),
          input: { a: -2, b: 8, meta: { constructor: null } } as unknown as InequalityInput,
        },
        {
          ...makeProbe({ probeId: "probe-plain-num-ctor", input: { a: -3, b: 12 } }),
          input: { a: -3, b: 12, meta: { constructor: 123 } } as unknown as InequalityInput,
        },
      ],
    });
    expect(plainNullCtorRes.status).toBe("active");
    expect(plainNullCtorRes.clinic!.steps[2].probes).toHaveLength(2);
  });

  it("enforces Round-9 P1-1..P1-9 and P2-1 guardrails, exotic rejections, revalidation, metadata, UTF-16 sort, and copy", async () => {
    const allSources = {
      "src-ch-1": "v1",
      "src-ch-2": "v1",
      "src-ch-3": "v1",
    };
    const baseAttempts = [
      makeAttempt({ attemptId: "a1", rootAttemptId: "r1", chapterId: "ch-1", localDate: "2026-10-01", sourceRefs: [{ sourceId: "src-ch-1", sourceVersion: "v1" }] }),
      makeAttempt({ attemptId: "a2", rootAttemptId: "r2", chapterId: "ch-2", localDate: "2026-10-03", sourceRefs: [{ sourceId: "src-ch-2", sourceVersion: "v1" }] }),
      makeAttempt({ attemptId: "a3", rootAttemptId: "r3", chapterId: "ch-3", localDate: "2026-10-05", sourceRefs: [{ sourceId: "src-ch-3", sourceVersion: "v1" }] }),
    ];
    const probe1 = makeProbe({ probeId: "r9-p1", input: { a: -2, b: 8 } });
    const probe2 = makeProbe({ probeId: "r9-p2", input: { a: -3, b: 12 } });

    // [P1-1] Rubric calibration / agreement guardrails, attempt quality flags, and delayedRecheck contract.
    const uncalRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: baseAttempts,
      candidateProbes: [probe1, probe2],
      rubricCalibration: { calibrated: false },
    });
    expect(uncalRes.status).toBe("uncalibrated_rubric");
    expect(uncalRes.clinic).toBeNull();

    for (const badAgreement of [
      { calibrated: true, agreementPassed: false, qwk: 0.85 },
      { calibrated: true, qwk: 0.69 },
      { calibrated: true, qwk: null },
      { calibrated: true, qwk: Number.NaN },
    ]) {
      const lowAgRes = generateRemedyClinic({
        learnerId: "learner-1",
        courseId: "course-alg-1",
        ruleId: RULE_ID,
        currentPrivacyEpoch: 5,
        activeSourcesMap: allSources,
        verifyRuleViolation: verifyNegativeSignFlip,
        attempts: baseAttempts,
        candidateProbes: [probe1, probe2],
        rubricCalibration: badAgreement,
      });
      expect(lowAgRes.status).toBe("low_rubric_agreement");
      expect(lowAgRes.clinic).toBeNull();
    }

    const filteredAttemptsRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: [
        { ...baseAttempts[0]!, swapConsistent: false },
        { ...baseAttempts[1]!, templatePadded: true },
        { ...baseAttempts[2]!, calibrationVerified: false },
      ],
      candidateProbes: [probe1, probe2],
      rubricCalibration: { calibrated: true, agreementPassed: true, qwk: 0.82 },
    });
    expect(filteredAttemptsRes.status).toBe("threshold_not_met");
    expect(filteredAttemptsRes.rejectedCounts.rubricGuardRejected).toBe(3);

    const activeRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: baseAttempts,
      candidateProbes: [probe1, probe2],
      rubricCalibration: { calibrated: true, agreementPassed: true, qwk: 0.82 },
    });
    expect(activeRes.status).toBe("active");
    const clinic = activeRes.clinic!;
    expect(clinic.totalMinutes).toBe(14);
    expect(Object.isFrozen(clinic.delayedRecheck)).toBe(true);
    expect(clinic.delayedRecheck).toEqual({
      required: true,
      scheduledOutsideSessionMinutes: true,
      minDelayHours: 24,
      ruleId: RULE_ID,
      countsTowardMasteryUntilPassed: false,
    });
    const tamperedRecheckReval = revalidateRemedyClinic(
      { ...clinic, delayedRecheck: { ...clinic.delayedRecheck, required: false as unknown as true } },
      allSources,
      6,
    );
    expect(tamperedRecheckReval.status).toBe("stale_source_revoked");

    // [P1-4] Throwing Proxy getPrototypeOf trap, reassigned-prototype Generator/AsyncGenerator, own "__proto__" in input.
    const throwingProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("proxy-trap-boom");
        },
      },
    );
    const reassignedGen = (function* () {
      yield 1;
    })();
    Object.setPrototypeOf(reassignedGen, Object.prototype);
    const reassignedAsyncGen = (async function* () {
      yield 1;
    })();
    Object.setPrototypeOf(reassignedAsyncGen, Object.prototype);
    const inputWithOwnProto = Object.defineProperty({ a: -2, b: 8 }, "__proto__", {
      value: { polluted: true },
      writable: true,
      enumerable: true,
      configurable: true,
    });

    for (const invalidProbe of [
      { ...makeProbe({ probeId: "p-proxy", input: { a: -2, b: 8 } }), input: { a: -2, b: 8, bad: throwingProxy } as unknown as InequalityInput },
      { ...makeProbe({ probeId: "p-gen", input: { a: -3, b: 12 } }), input: { a: -3, b: 12, bad: reassignedGen } as unknown as InequalityInput },
      { ...makeProbe({ probeId: "p-agen", input: { a: -4, b: 16 } }), input: { a: -4, b: 16, bad: reassignedAsyncGen } as unknown as InequalityInput },
      { ...makeProbe({ probeId: "p-ownproto", input: { a: -5, b: 20 } }), input: inputWithOwnProto as unknown as InequalityInput },
    ]) {
      const result = generateRemedyClinic({
        learnerId: "learner-1",
        courseId: "course-alg-1",
        ruleId: RULE_ID,
        currentPrivacyEpoch: 5,
        activeSourcesMap: allSources,
        verifyRuleViolation: verifyNegativeSignFlip,
        attempts: baseAttempts,
        candidateProbes: [invalidProbe],
      });
      expect(result).toMatchObject({ status: "invalid_input", clinic: null });
    }

    // [P1-5] Rejected Promise with reassigned prototype (Object.prototype & null) MUST be rejected
    // WITHOUT attaching .then reactions (unhandledRejection is NOT suppressed).
    const unhandledReasons: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandledReasons.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const errObjProto = new Error("unhandled-obj-proto");
    const errNullProto = new Error("unhandled-null-proto");
    const rejObjProto = Promise.reject(errObjProto);
    const rejNullProto = Promise.reject(errNullProto);
    Object.setPrototypeOf(rejObjProto, Object.prototype);
    Object.setPrototypeOf(rejNullProto, null);
    try {
      for (const invalidProbe of [
        { ...makeProbe({ probeId: "p-rej-obj", input: { a: -2, b: 8 } }), input: { a: -2, b: 8, p: rejObjProto } as unknown as InequalityInput },
        { ...makeProbe({ probeId: "p-rej-null", input: { a: -3, b: 12 } }), input: { a: -3, b: 12, p: rejNullProto } as unknown as InequalityInput },
      ]) {
        const result = generateRemedyClinic({
          learnerId: "learner-1",
          courseId: "course-alg-1",
          ruleId: RULE_ID,
          currentPrivacyEpoch: 5,
          activeSourcesMap: allSources,
          verifyRuleViolation: verifyNegativeSignFlip,
          attempts: baseAttempts,
          candidateProbes: [invalidProbe],
        });
        expect(result).toMatchObject({ status: "invalid_input", clinic: null });
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(unhandledReasons).toContain(errObjProto);
      expect(unhandledReasons).toContain(errNullProto);
    } finally {
      Object.setPrototypeOf(rejObjProto, Promise.prototype);
      Object.setPrototypeOf(rejNullProto, Promise.prototype);
      rejObjProto.catch(() => {});
      rejNullProto.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 5));
      process.off("unhandledRejection", onUnhandled);
    }

    // [P1-6] Self-contained closed-core probe verifier rejects nondeterminism and exotic predict returns cleanly.
    let flips = 0;
    const nondetProbe: DistinguishableProbeSpec<InequalityInput, string> = {
      ...makeProbe({ probeId: "p-nondet", input: { a: -2, b: 8 } }),
      correctModel: {
        id: "M_star",
        label: "Flaky model",
        role: "correct",
        predict: () => `v-${++flips}`,
      },
    };
    const exoticReturnProbe: DistinguishableProbeSpec<InequalityInput, unknown> = {
      ...makeProbe({ probeId: "p-exotic-return", input: { a: -3, b: 12 } }),
      correctModel: {
        id: "M_star",
        label: "Returns exotic generator",
        role: "correct",
        predict: () => reassignedGen,
      },
      observableKey: (v) => String(v),
    };
    const builtinVerifierRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: baseAttempts,
      candidateProbes: [nondetProbe, exoticReturnProbe],
    });
    expect(builtinVerifierRes.status).toBe("insufficient_distinguishable_probes");
    expect(builtinVerifierRes.rejectedProbes[0]!.report!.issues).toContain("nondeterministic_prediction");
    expect(builtinVerifierRes.rejectedProbes[1]!.report!.issues).toContain("prediction_failed");

    // [P1-7] revalidateRemedyClinic rejects duplicate probes [p, p] and malformed report: {}.
    const dupProbeReval = revalidateRemedyClinic(
      {
        ...clinic,
        steps: [
          clinic.steps[0],
          clinic.steps[1],
          { ...clinic.steps[2], probes: [clinic.steps[2].probes[0]!, clinic.steps[2].probes[0]!] },
        ] as typeof clinic.steps,
      },
      allSources,
      6,
    );
    expect(dupProbeReval.status).toBe("stale_source_revoked");
    expect(dupProbeReval.revocationSummary.reason).toBe("insufficient_surviving_probes");
    expect(dupProbeReval.steps[1].prompt).toContain("transfer probes");

    const emptyReportReval = revalidateRemedyClinic(
      {
        ...clinic,
        steps: [
          clinic.steps[0],
          clinic.steps[1],
          {
            ...clinic.steps[2],
            probes: [
              { ...clinic.steps[2].probes[0]!, report: {} as typeof clinic.steps[2]["probes"][0]["report"] },
              clinic.steps[2].probes[1]!,
            ],
          },
        ] as typeof clinic.steps,
      },
      allSources,
      6,
    );
    expect(emptyReportReval.status).toBe("stale_source_revoked");
    expect(emptyReportReval.revocationSummary.reason).toBe("insufficient_surviving_probes");

    // [P1-8] observableKey receiver preserves frozen targetMisconceptionId & sourceRefs.
    const metaProbe: ClinicCandidateProbe<InequalityInput, number> = {
      probeId: "probe-target-meta",
      requirementKey: "alg.ineq",
      prompt: "Meta receiver rounding probe",
      targetMisconceptionId: RULE_ID,
      sourceRefs: [{ sourceId: "src-ch-1", sourceVersion: "v1" }],
      input: { a: -2, b: 8 },
      correctModel: { id: "M_star", label: "Correct", role: "correct", predict: () => 1.1 },
      hypotheses: [
        { id: RULE_ID, label: "Target misconception", role: "misconception", description: "1.2", predict: () => 1.2 },
        { id: "h2", label: "Other", role: "misconception", description: "3.0", predict: () => 3.0 },
      ],
      observableKey(
        this: { targetMisconceptionId?: string; sourceRefs?: readonly { sourceId: string }[] },
        obs: number,
      ) {
        return this?.targetMisconceptionId === RULE_ID && this?.sourceRefs?.[0]?.sourceId === "src-ch-1"
          ? String(Math.round(obs))
          : String(obs);
      },
      parseResponse: (r) => (typeof r === "number" ? r : null),
    };
    const metaRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: baseAttempts,
      candidateProbes: [metaProbe, probe2],
    });
    expect(metaRes.status).toBe("insufficient_distinguishable_probes");
    expect(metaRes.rejectedProbes[0]!.reason).toBe("not_distinguishable");

    // [P1-9] Same-date same-time attempts "ä" vs "z" follow deterministic UTF-16 code-unit order ('z' < 'ä').
    const utf16Res = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: [
        makeAttempt({ attemptId: "ä", rootAttemptId: "r-tie", chapterId: "ch-1", localDate: "2026-10-01", occurredAtMs: 1000, sourceRefs: [{ sourceId: "src-ch-1", sourceVersion: "v1" }] }),
        makeAttempt({ attemptId: "z", rootAttemptId: "r-tie", chapterId: "ch-1", localDate: "2026-10-01", occurredAtMs: 1000, sourceRefs: [{ sourceId: "src-ch-1", sourceVersion: "v1" }] }),
        baseAttempts[1]!,
        baseAttempts[2]!,
      ],
      candidateProbes: [probe1, probe2],
    });
    expect(utf16Res.status).toBe("active");
    const chosenTieCase = utf16Res.clinic!.evidenceCases.find((c) => c.rootAttemptId === "r-tie");
    expect(chosenTieCase!.attemptId).toBe("z");

    // [P2-1] invalid_privacy_epoch produces accurate privacy-state placeholder copy (not source-updated copy).
    const epochRegressedReval = revalidateRemedyClinic(clinic, allSources, 4);
    expect(epochRegressedReval.status).toBe("stale_source_revoked");
    expect(epochRegressedReval.revocationSummary.reason).toBe("invalid_privacy_epoch");
    expect(epochRegressedReval.steps[1].prompt).toContain("privacy verification state");
    expect(epochRegressedReval.steps[1].prompt).not.toContain("underlying source was updated or removed");

    // [P2-B] Revalidating an already-revoked invalid_privacy_epoch clinic preserves reason and placeholder copy.
    const revalAlreadyRevoked = revalidateRemedyClinic(epochRegressedReval, allSources, 6);
    expect(revalAlreadyRevoked.status).toBe("stale_source_revoked");
    expect(revalAlreadyRevoked.revocationSummary.reason).toBe("invalid_privacy_epoch");
    expect(revalAlreadyRevoked.steps[1].prompt).toContain("privacy verification state");
  });

  it("defeats Round-10 Proxy .length traps, multi-read Proxy TOCTOU, exotic containers, forged Maps, and direct privacy-guard traps", async () => {
    const allSources = {
      "src-ch-1": { version: "v1", active: true },
      "src-ch-2": { version: "v1", active: true },
      "src-ch-3": { version: "v1", active: true },
    };
    const baseAttempts = [
      makeAttempt({ attemptId: "a1", rootAttemptId: "r1", chapterId: "ch-1", localDate: "2026-10-01", sourceRefs: [{ sourceId: "src-ch-1", sourceVersion: "v1" }] }),
      makeAttempt({ attemptId: "a2", rootAttemptId: "r2", chapterId: "ch-2", localDate: "2026-10-03", sourceRefs: [{ sourceId: "src-ch-2", sourceVersion: "v1" }] }),
      makeAttempt({ attemptId: "a3", rootAttemptId: "r3", chapterId: "ch-3", localDate: "2026-10-05", sourceRefs: [{ sourceId: "src-ch-3", sourceVersion: "v1" }] }),
    ];
    const probe1 = makeProbe({ probeId: "r10-p1", input: { a: -2, b: 8 } });
    const probe2 = makeProbe({ probeId: "r10-p2", input: { a: -3, b: 12 } });
    const baseRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: baseAttempts,
      candidateProbes: [probe1, probe2],
    });
    expect(baseRes.status).toBe("active");
    const clinic = baseRes.clinic!;

    // 1. Proxy arrays with throwing get("length") trap (or read-1=3, read-2=throw) on probe.sourceRefs,
    //    input.attempts, clinic.steps, and clinic.evidenceCases must NEVER throw uncaught.
    const makeThrowingLenProxy = <T>(arr: readonly T[], throwOnSecondRead = false): T[] => {
      let reads = 0;
      return new Proxy([...arr], {
        get(target, prop, receiver) {
          if (prop === "length") {
            reads += 1;
            if (!throwOnSecondRead || reads >= 2) throw new Error("length-trap-boom");
            return target.length;
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    };

    const proxySourceRefsProbe = {
      ...makeProbe({ probeId: "r10-proxy-refs", input: { a: -4, b: 16 } }),
      sourceRefs: makeThrowingLenProxy([{ sourceId: "src-ch-1", sourceVersion: "v1" }]),
    };
    const proxySourceRefsRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: baseAttempts,
      candidateProbes: [proxySourceRefsProbe, probe2],
    });
    expect(proxySourceRefsRes).toMatchObject({ status: "invalid_input", clinic: null });

    const proxyAttemptsRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: makeThrowingLenProxy(baseAttempts, true),
      candidateProbes: [probe1, probe2],
    });
    expect(proxyAttemptsRes.status).toBe("invalid_input");
    expect(proxyAttemptsRes.clinic).toBeNull();

    const proxyStepsReval = revalidateRemedyClinic(
      { ...clinic, steps: makeThrowingLenProxy(clinic.steps) as unknown as typeof clinic.steps },
      allSources,
      6,
    );
    expect(proxyStepsReval.status).toBe("stale_source_revoked");

    const proxyCasesReval = revalidateRemedyClinic(
      { ...clinic, evidenceCases: makeThrowingLenProxy(clinic.evidenceCases) },
      allSources,
      6,
    );
    expect(proxyCasesReval.status).toBe("stale_source_revoked");

    // 2. Prototype-reassigned rejected Promise (verifying unhandledRejection is NOT suppressed!) and
    //    Generator objects as attempts, source records, and callback carriers are rejected at their respective boundaries.
    const unhandledReasons: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandledReasons.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const makeReassignedRejectedPromise = (tag: string, props: Record<string, unknown>) => {
      const err = new Error(`r10-unhandled-${tag}`);
      const p = Promise.reject(err);
      Object.setPrototypeOf(p, Object.prototype);
      Object.assign(p, props);
      return { p, err };
    };
    const makeReassignedGenerator = (props: Record<string, unknown>) => {
      const g = (function* () {
        yield 1;
      })();
      Object.setPrototypeOf(g, Object.prototype);
      Object.assign(g, props);
      return g;
    };

    const pAttempt = makeReassignedRejectedPromise("attempt", { ...baseAttempts[0]! });
    const pSources = makeReassignedRejectedPromise("sources", { ...allSources });
    const pProbe = makeReassignedRejectedPromise("probe", { ...probe1 });
    const pModel = makeReassignedRejectedPromise("model", { ...probe1.correctModel });
    const gAttempt = makeReassignedGenerator({ ...baseAttempts[0]! });
    const gSources = makeReassignedGenerator({ ...allSources });
    const gProbe = Object.assign((function* () {})(), probe1);
    const gModel = Object.assign((function* () {})(), probe1.correctModel);

    try {
      const pAttemptRes = generateRemedyClinic({
        learnerId: "learner-1",
        courseId: "course-alg-1",
        ruleId: RULE_ID,
        currentPrivacyEpoch: 5,
        activeSourcesMap: allSources,
        verifyRuleViolation: verifyNegativeSignFlip,
        attempts: [pAttempt.p as unknown as DiagnosedRootAttempt, baseAttempts[1]!, baseAttempts[2]!],
        candidateProbes: [probe1, probe2],
      });
      expect(pAttemptRes).toMatchObject({ status: "invalid_input", clinic: null });

      const gAttemptRes = generateRemedyClinic({
        learnerId: "learner-1",
        courseId: "course-alg-1",
        ruleId: RULE_ID,
        currentPrivacyEpoch: 5,
        activeSourcesMap: allSources,
        verifyRuleViolation: verifyNegativeSignFlip,
        attempts: [gAttempt as unknown as DiagnosedRootAttempt, baseAttempts[1]!, baseAttempts[2]!],
        candidateProbes: [probe1, probe2],
      });
      expect(gAttemptRes).toMatchObject({ status: "invalid_input", clinic: null });

      const pSourcesRes = generateRemedyClinic({
        learnerId: "learner-1",
        courseId: "course-alg-1",
        ruleId: RULE_ID,
        currentPrivacyEpoch: 5,
        activeSourcesMap: pSources.p as unknown as ActiveSourcesMap,
        verifyRuleViolation: verifyNegativeSignFlip,
        attempts: baseAttempts,
        candidateProbes: [probe1, probe2],
      });
      expect(pSourcesRes.status).toBe("invalid_input");
      expect(pSourcesRes.clinic).toBeNull();

      const gSourcesRes = generateRemedyClinic({
        learnerId: "learner-1",
        courseId: "course-alg-1",
        ruleId: RULE_ID,
        currentPrivacyEpoch: 5,
        activeSourcesMap: gSources as unknown as ActiveSourcesMap,
        verifyRuleViolation: verifyNegativeSignFlip,
        attempts: baseAttempts,
        candidateProbes: [probe1, probe2],
      });
      expect(gSourcesRes.status).toBe("invalid_input");
      expect(gSourcesRes.clinic).toBeNull();

      for (const invalidProbe of [
        pProbe.p as unknown as ClinicCandidateProbe<InequalityInput, string>,
        gProbe as unknown as ClinicCandidateProbe<InequalityInput, string>,
        { ...probe1, probeId: "r10-p-model", correctModel: pModel.p as unknown as typeof probe1.correctModel },
        { ...probe1, probeId: "r10-g-model", correctModel: gModel as unknown as typeof probe1.correctModel },
      ]) {
        const result = generateRemedyClinic({
          learnerId: "learner-1",
          courseId: "course-alg-1",
          ruleId: RULE_ID,
          currentPrivacyEpoch: 5,
          activeSourcesMap: allSources,
          verifyRuleViolation: verifyNegativeSignFlip,
          attempts: baseAttempts,
          candidateProbes: [invalidProbe],
        });
        expect(result).toMatchObject({ status: "invalid_input", clinic: null });
      }

      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(unhandledReasons).toContain(pAttempt.err);
      expect(unhandledReasons).toContain(pSources.err);
      expect(unhandledReasons).toContain(pProbe.err);
      expect(unhandledReasons).toContain(pModel.err);
    } finally {
      for (const item of [pAttempt.p, pSources.p, pProbe.p, pModel.p]) {
        Object.setPrototypeOf(item, Promise.prototype);
        item.catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      process.off("unhandledRejection", onUnhandled);
    }

    // 3. Stateful Proxy candidateProbe returning revoked sourceRefs on read 1 and undefined on read 2
    //    must invalidate the input before source-ref schema checks.
    let sourceRefDescReads = 0;
    const statefulProxyProbe = new Proxy(
      { ...makeProbe({ probeId: "r10-toctou-probe", input: { a: -5, b: 20 } }) },
      {
        ownKeys(target) {
          return [...Reflect.ownKeys(target), "sourceRefs"];
        },
        getOwnPropertyDescriptor(target, prop) {
          if (prop === "sourceRefs") {
            sourceRefDescReads += 1;
            return {
              value:
                sourceRefDescReads === 1
                  ? [{ sourceId: "src-revoked-secret", sourceVersion: "v1" }]
                  : undefined,
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      },
    );
    const toctouRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: baseAttempts,
      candidateProbes: [statefulProxyProbe, probe2],
    });
    expect(sourceRefDescReads).toBe(2);
    expect(toctouRes).toMatchObject({ status: "invalid_input", clinic: null });

    // 4. Forged Map.prototype object and Proxy-wrapped / throwing activeSourcesMap fail closed with zero partial entries.
    const forgedMap = Object.assign(Object.create(Map.prototype) as Record<string, unknown>, {
      entries() {
        return [
          ["src-ch-1", "v1"],
          ["src-ch-2", "v1"],
          ["src-ch-3", "v1"],
        ];
      },
      get() {
        return "v1";
      },
    }) as unknown as ActiveSourcesMap;
    const forgedMapRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: forgedMap,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: baseAttempts,
      candidateProbes: [probe1, probe2],
    });
    expect(forgedMapRes.status).toBe("invalid_input");
    expect(forgedMapRes.clinic).toBeNull();

    const realMap = new Map<string, { readonly version: string; readonly active: boolean }>([
      ["src-ch-1", { version: "v1", active: true }],
      ["src-ch-2", { version: "v1", active: true }],
      ["src-ch-3", { version: "v1", active: true }],
    ]);
    const proxyMap = new Proxy(realMap, {}) as unknown as ActiveSourcesMap;
    const proxyMapReval = revalidateRemedyClinic(clinic, proxyMap, 6);
    expect(proxyMapReval.status).toBe("stale_source_revoked");

    // Outer record getter on activeSourcesMap must fail closed with zero partial survival and zero getter runs.
    let outerMapGetterRuns = 0;
    const poisonRecord = {
      "src-ch-1": "v1",
      "src-ch-2": "v1",
      "src-ch-3": "v1",
    };
    Object.defineProperty(poisonRecord, "src-poison", {
      enumerable: true,
      get() {
        outerMapGetterRuns += 1;
        throw new Error("mid-iter-boom");
      },
    });
    const poisonRecordReval = revalidateRemedyClinic(clinic, poisonRecord as unknown as ActiveSourcesMap, 6);
    expect(outerMapGetterRuns).toBe(0);
    expect(poisonRecordReval.status).toBe("stale_source_revoked");

    // Genuine Map with a non-string key must fail closed at container level (zero partial survival).
    const badKeyMap = new Map<unknown, unknown>([
      ["src-ch-1", "v1"],
      ["src-ch-2", "v1"],
      ["src-ch-3", "v1"],
      [new Proxy({}, {}), "v1"],
    ]) as unknown as ActiveSourcesMap;
    const badKeyMapReval = revalidateRemedyClinic(clinic, badKeyMap, 6);
    expect(badKeyMapReval.status).toBe("stale_source_revoked");

    // 5. Direct privacy-guard exports fail closed against throwing Proxy and forged Map.
    expect(isSourceRefActive({ sourceId: "src-ch-1", sourceVersion: "v1" }, forgedMap)).toBe(false);
    expect(
      areSourceRefsActive(
        makeThrowingLenProxy([{ sourceId: "src-ch-1", sourceVersion: "v1" }]),
        allSources,
      ),
    ).toBe(false);
    expect(
      cloneSourceRefs(makeThrowingLenProxy([{ sourceId: "src-ch-1", sourceVersion: "v1" }])),
    ).toEqual([]);
    const throwingCaseProxy = new Proxy(clinic.evidenceCases[0]!, {
      getPrototypeOf() {
        throw new Error("case-proxy-boom");
      },
    });
    expect(cloneEvidenceCase(throwingCaseProxy).attemptId).toBe("");
  });

  it("enforces Round-11 zero-getter sourceRefs fallback, AsyncGenerator container checks, and privacy-guard single-pass hardening", async () => {
    const allSources = {
      "src-ch-1": { version: "v1", active: true },
      "src-ch-2": { version: "v1", active: true },
      "src-ch-3": { version: "v1", active: true },
    };
    const baseAttempts = [
      makeAttempt({ attemptId: "a1", rootAttemptId: "r1", chapterId: "ch-1", localDate: "2026-10-01", sourceRefs: [{ sourceId: "src-ch-1", sourceVersion: "v1" }] }),
      makeAttempt({ attemptId: "a2", rootAttemptId: "r2", chapterId: "ch-2", localDate: "2026-10-03", sourceRefs: [{ sourceId: "src-ch-2", sourceVersion: "v1" }] }),
      makeAttempt({ attemptId: "a3", rootAttemptId: "r3", chapterId: "ch-3", localDate: "2026-10-05", sourceRefs: [{ sourceId: "src-ch-3", sourceVersion: "v1" }] }),
    ];
    const probe1 = makeProbe({ probeId: "r11-p1", input: { a: -2, b: 8 } });
    const probe2 = makeProbe({ probeId: "r11-p2", input: { a: -3, b: 12 } });

    // [P1-1] Element getter, array-slot getter, and stateful Proxy sourceRefs must execute ZERO getters
    // and invalidate the input before source-ref schema checks.
    let getterRuns = 0;
    const elemGetterRef = Object.defineProperty({ sourceVersion: "v1" }, "sourceId", {
      enumerable: true,
      get() {
        getterRuns += 1;
        return "src-ch-1";
      },
    }) as unknown as { sourceId: string; sourceVersion: string };
    const slotGetterRefs = Object.defineProperty([] as Array<{ sourceId: string; sourceVersion: string }>, "0", {
      enumerable: true,
      get() {
        getterRuns += 1;
        return { sourceId: "src-ch-1", sourceVersion: "v1" };
      },
    });
    let proxyRefsDescReads = 0;
    const statefulProxyRefs = new Proxy([{ sourceId: "src-ch-1", sourceVersion: "v1" }], {
      getOwnPropertyDescriptor(target, prop) {
        if (prop === "0") {
          proxyRefsDescReads += 1;
          return {
            value:
              proxyRefsDescReads === 1
                ? { sourceId: "src-ch-1", sourceVersion: "v1" }
                : { sourceId: "src-revoked", sourceVersion: "v1" },
            writable: true,
            enumerable: true,
            configurable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });

    for (const invalidProbe of [
      { ...makeProbe({ probeId: "r11-elem-getter", input: { a: -2, b: 8 } }), sourceRefs: [elemGetterRef] },
      { ...makeProbe({ probeId: "r11-slot-getter", input: { a: -3, b: 12 } }), sourceRefs: slotGetterRefs },
      { ...makeProbe({ probeId: "r11-proxy-refs", input: { a: -4, b: 16 } }), sourceRefs: statefulProxyRefs },
    ]) {
      const result = generateRemedyClinic({
        learnerId: "learner-1",
        courseId: "course-alg-1",
        ruleId: RULE_ID,
        currentPrivacyEpoch: 5,
        activeSourcesMap: allSources,
        verifyRuleViolation: verifyNegativeSignFlip,
        attempts: baseAttempts,
        candidateProbes: [invalidProbe],
      });
      expect(result).toMatchObject({ status: "invalid_input", clinic: null });
    }
    expect(getterRuns).toBe(0);
    expect(proxyRefsDescReads).toBe(2);

    // [P2-2] AsyncGenerator passed as input, candidateProbe, correctModel, and hypothesis
    // MUST be rejected cleanly, while plain objects succeed with ZERO unhandledRejection events.
    const unhandledErrors: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandledErrors.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const makeAsyncGenObj = (props: Record<string, unknown>) => {
        const ag = (async function* () {
          yield 1;
        })();
        Object.assign(ag, props);
        return ag;
      };

      const plainOk = generateRemedyClinic({
        learnerId: "learner-1",
        courseId: "course-alg-1",
        ruleId: RULE_ID,
        currentPrivacyEpoch: 5,
        activeSourcesMap: allSources,
        verifyRuleViolation: verifyNegativeSignFlip,
        attempts: baseAttempts,
        candidateProbes: [probe1, probe2],
      });
      expect(plainOk.status).toBe("active");

      const agInput = makeAsyncGenObj({
        learnerId: "learner-1",
        courseId: "course-alg-1",
        ruleId: RULE_ID,
        currentPrivacyEpoch: 5,
        activeSourcesMap: allSources,
        verifyRuleViolation: verifyNegativeSignFlip,
        attempts: baseAttempts,
        candidateProbes: [probe1, probe2],
      });
      const agInputRes = generateRemedyClinic(
        agInput as unknown as Parameters<typeof generateRemedyClinic<InequalityInput, string>>[0],
      );
      expect(agInputRes.status).toBe("invalid_input");
      expect(agInputRes.clinic).toBeNull();

      const agProbe = makeAsyncGenObj({ ...probe1, probeId: "r11-ag-probe" });
      const agCorrectModel = makeAsyncGenObj({ ...probe1.correctModel });
      const agHyp = makeAsyncGenObj({ ...probe1.hypotheses[0]! });
      for (const invalidProbe of [
        agProbe as unknown as ClinicCandidateProbe<InequalityInput, string>,
        { ...probe1, probeId: "r11-ag-correct", correctModel: agCorrectModel as unknown as typeof probe1.correctModel },
        {
          ...probe1,
          probeId: "r11-ag-hyp",
          hypotheses: [agHyp as unknown as (typeof probe1.hypotheses)[0], probe1.hypotheses[1]!],
        },
      ]) {
        const result = generateRemedyClinic({
          learnerId: "learner-1",
          courseId: "course-alg-1",
          ruleId: RULE_ID,
          currentPrivacyEpoch: 5,
          activeSourcesMap: allSources,
          verifyRuleViolation: verifyNegativeSignFlip,
          attempts: baseAttempts,
          candidateProbes: [invalidProbe],
        });
        expect(result).toMatchObject({ status: "invalid_input", clinic: null });
      }

      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(unhandledErrors).toEqual([]);

      // [P2-1] privacy-guard direct exports: cloneEvidenceCase / selectSpreadRepresentativeCases
      // and Proxy / reassigned-Promise Record activeSourcesMap rejection.
      const baseClinic = plainOk.clinic!;
      const validCase = baseClinic.evidenceCases[0]!;
      let caseDescReads = 0;
      const statefulCaseProxy = new Proxy(
        { ...validCase },
        {
          getOwnPropertyDescriptor(target, prop) {
            if (prop === "attemptId") caseDescReads += 1;
            return Reflect.getOwnPropertyDescriptor(target, prop);
          },
        },
      );
      expect(cloneEvidenceCase(statefulCaseProxy).attemptId).toBe("");
      expect(caseDescReads).toBe(2);

      const errCase = new Error("r11-case-promise");
      const promiseCase = Promise.reject(errCase);
      Object.setPrototypeOf(promiseCase, Object.prototype);
      Object.assign(promiseCase, { ...validCase });

      const errSources = new Error("r11-sources-promise");
      const promiseSources = Promise.reject(errSources);
      Object.setPrototypeOf(promiseSources, Object.prototype);
      Object.assign(promiseSources, { ...allSources });

      try {
        expect(cloneEvidenceCase(promiseCase as unknown as typeof validCase).attemptId).toBe("");
        const spreadFromPromise = selectSpreadRepresentativeCases([
          promiseCase as unknown as typeof validCase,
          baseClinic.evidenceCases[1]!,
          baseClinic.evidenceCases[2]!,
        ]);
        expect(spreadFromPromise).toEqual([]);

        const proxyRecordSources = new Proxy({ ...allSources }, {}) as unknown as ActiveSourcesMap;
        expect(isSourceRefActive({ sourceId: "src-ch-1", sourceVersion: "v1" }, proxyRecordSources)).toBe(false);
        expect(areSourceRefsActive([{ sourceId: "src-ch-1", sourceVersion: "v1" }], proxyRecordSources)).toBe(false);
        expect(
          isSourceRefActive(
            { sourceId: "src-ch-1", sourceVersion: "v1" },
            promiseSources as unknown as ActiveSourcesMap,
          ),
        ).toBe(false);
        expect(
          areSourceRefsActive(
            [{ sourceId: "src-ch-1", sourceVersion: "v1" }],
            promiseSources as unknown as ActiveSourcesMap,
          ),
        ).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, 15));
        expect(unhandledErrors).toContain(errCase);
        expect(unhandledErrors).toContain(errSources);
      } finally {
        for (const p of [promiseCase, promiseSources]) {
          Object.setPrototypeOf(p, Promise.prototype);
          p.catch(() => {});
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("enforces Round-12 target misconception binding, strict boolean active/revoked source flags, and non-blank revalidation roots", () => {
    const allSources = {
      "src-ch-1": { version: "v1", active: true },
      "src-ch-2": { version: "v1", active: true },
      "src-ch-3": { version: "v1", active: true },
    };
    const baseAttempts = [
      makeAttempt({ attemptId: "a1", rootAttemptId: "r1", chapterId: "ch-1", localDate: "2026-10-01", sourceRefs: [{ sourceId: "src-ch-1", sourceVersion: "v1" }] }),
      makeAttempt({ attemptId: "a2", rootAttemptId: "r2", chapterId: "ch-2", localDate: "2026-10-03", sourceRefs: [{ sourceId: "src-ch-2", sourceVersion: "v1" }] }),
      makeAttempt({ attemptId: "a3", rootAttemptId: "r3", chapterId: "ch-3", localDate: "2026-10-05", sourceRefs: [{ sourceId: "src-ch-3", sourceVersion: "v1" }] }),
    ];
    const probe1 = makeProbe({ probeId: "r12-p1", input: { a: -2, b: 8 } });
    const probe2 = makeProbe({ probeId: "r12-p2", input: { a: -3, b: 12 } });

    const baselineRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: baseAttempts,
      candidateProbes: [probe1, probe2],
    });
    expect(baselineRes.status).toBe("active");
    const clinic = baselineRes.clinic!;

    // [P1-3] Generation rejects probes missing targetMisconceptionId, targeting a different ruleId,
    // or omitting a misconception hypothesis matching clinic ruleId.
    const noTargetProbe: ClinicCandidateProbe<InequalityInput, string> = { ...probe1, probeId: "r12-no-target" };
    delete (noTargetProbe as { targetMisconceptionId?: string }).targetMisconceptionId;
    const wrongTargetProbe = makeProbe({
      probeId: "r12-wrong-target",
      input: { a: -4, b: 16 },
      targetMisconceptionId: "unrelated_rule",
    });
    const missingRuleHypProbe: ClinicCandidateProbe<InequalityInput, string> = {
      ...makeProbe({ probeId: "r12-missing-hyp", input: { a: -5, b: 20 } }),
      hypotheses: [
        {
          id: "unrelated_hyp_a",
          label: "Unrelated A",
          role: "misconception",
          description: "Unrelated misconception A",
          predict: ({ a, b }) => `x <= ${b / a}`,
        },
        {
          id: "unrelated_hyp_b",
          label: "Unrelated B",
          role: "misconception",
          description: "Unrelated misconception B",
          predict: ({ a, b }) => `x <= ${b / Math.abs(a)}`,
        },
      ],
    };
    const mismatchGenRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: baseAttempts,
      candidateProbes: [noTargetProbe, wrongTargetProbe, missingRuleHypProbe],
    });
    expect(mismatchGenRes.status).toBe("insufficient_distinguishable_probes");
    expect(mismatchGenRes.rejectedProbes.map((r) => r.reason)).toEqual([
      "target_misconception_mismatch",
      "target_misconception_mismatch",
      "target_misconception_mismatch",
    ]);

    // [P1-3] Revalidation rejects Step-3 probes whose targetMisconceptionId or report.predictions omit header.ruleId.
    const unrelatedProbeInClinic = {
      ...clinic.steps[2].probes[0]!,
      targetMisconceptionId: RULE_ID,
      competingModelIds: ["M_star", "unrelated_hyp_a", "unrelated_hyp_b"],
      report: {
        ...clinic.steps[2].probes[0]!.report,
        predictions: [
          { modelId: "M_star", role: "correct" as const, observableKey: "x >= -4" },
          { modelId: "unrelated_hyp_a", role: "misconception" as const, observableKey: "x <= -4" },
          { modelId: "unrelated_hyp_b", role: "misconception" as const, observableKey: "x <= 4" },
        ],
      },
    };
    const revalOmittedTargetModel = revalidateRemedyClinic(
      {
        ...clinic,
        steps: [
          clinic.steps[0],
          clinic.steps[1],
          { ...clinic.steps[2], probes: [unrelatedProbeInClinic, clinic.steps[2].probes[1]!] },
        ] as typeof clinic.steps,
      },
      allSources,
      6,
    );
    expect(revalOmittedTargetModel.status).toBe("stale_source_revoked");
    expect(revalOmittedTargetModel.revocationSummary.reason).toBe("insufficient_surviving_probes");

    const revalWrongTargetProp = revalidateRemedyClinic(
      {
        ...clinic,
        steps: [
          clinic.steps[0],
          clinic.steps[1],
          {
            ...clinic.steps[2],
            probes: [
              { ...clinic.steps[2].probes[0]!, targetMisconceptionId: "wrong_rule" },
              clinic.steps[2].probes[1]!,
            ],
          },
        ] as typeof clinic.steps,
      },
      allSources,
      6,
    );
    expect(revalWrongTargetProp.status).toBe("stale_source_revoked");
    expect(revalWrongTargetProp.revocationSummary.reason).toBe("insufficient_surviving_probes");

    // [P1-4] Malformed non-boolean revoked/active flags or blank version reject ONLY that source (not valid siblings).
    const malformedFlagsSources = {
      "src-revoked-str": { version: "v1", revoked: "true" } as unknown as { version: string; revoked: boolean },
      "src-active-str": { version: "v1", active: "false" } as unknown as { version: string; active: boolean },
      "src-blank-ver": { version: "", revoked: false },
      "src-ch-2": { version: "v1", active: true },
      "src-ch-3": { version: "v1", active: true },
    } as ActiveSourcesMap;
    expect(isSourceRefActive({ sourceId: "src-revoked-str", sourceVersion: "v1" }, malformedFlagsSources)).toBe(false);
    expect(isSourceRefActive({ sourceId: "src-active-str", sourceVersion: "v1" }, malformedFlagsSources)).toBe(false);
    expect(isSourceRefActive({ sourceId: "src-blank-ver", sourceVersion: "" }, malformedFlagsSources)).toBe(false);
    expect(isSourceRefActive({ sourceId: "src-ch-2", sourceVersion: "v1" }, malformedFlagsSources)).toBe(true);

    const revalMalformedRevoked = revalidateRemedyClinic(
      clinic,
      {
        "src-ch-1": { version: "v1", revoked: "true" } as unknown as { version: string; revoked: boolean },
        "src-ch-2": { version: "v1", active: true },
        "src-ch-3": { version: "v1", active: true },
      },
      6,
    );
    expect(revalMalformedRevoked.status).toBe("stale_source_revoked");
    expect(revalMalformedRevoked.coverage.rootAttemptCount).toBe(2);
    expect(revalMalformedRevoked.revocationSummary.reason).toBe("insufficient_surviving_evidence");

    // [P1-5] Revalidation rejects blank/whitespace rootAttemptId, attemptId, chapterId, or invalid localDate.
    for (const tamperedCase of [
      { ...clinic.evidenceCases[2]!, rootAttemptId: "" },
      { ...clinic.evidenceCases[2]!, rootAttemptId: "   " },
      { ...clinic.evidenceCases[2]!, attemptId: "   " },
      { ...clinic.evidenceCases[2]!, chapterId: "" },
      { ...clinic.evidenceCases[2]!, localDate: "2026-02-30" },
    ]) {
      const blankRootReval = revalidateRemedyClinic(
        {
          ...clinic,
          evidenceCases: [clinic.evidenceCases[0]!, clinic.evidenceCases[1]!, tamperedCase],
        },
        allSources,
        6,
      );
      expect(blankRootReval.status).toBe("stale_source_revoked");
      expect(blankRootReval.coverage.rootAttemptCount).toBe(2);
      expect(blankRootReval.revocationSummary.reason).toBe("insufficient_surviving_evidence");
    }

    // Round-14 [P1-2 & P1-3]: Unified JS-security vs plain-data-schema boundary on activeSourcesMap.
    // 1) Plain-data malformed siblings ({ active: {} }, { revoked: [] }, { active: "yes" }, { version: "" },
    //    null, true, [], NaN) degrade ONLY those entries while preserving valid siblings in BOTH
    //    snapshotActiveSourcesMap / inspectActiveSourcesMap AND generateRemedyClinic / revalidateRemedyClinic.
    const plainBadSiblingRecord = {
      "src-ch-1": { version: "v1", active: true },
      "src-ch-2": { version: "v1", active: true },
      "src-ch-3": { version: "v1", active: true },
      "src-bad-obj": { version: "v1", active: {} },
      "src-bad-arr": { version: "v1", revoked: [] },
      "src-bad-str": { version: "v1", active: "yes" },
      "src-bad-blank": { version: "" },
      "src-bad-null": null,
      "src-bad-bool": true,
      "src-bad-list": ["v1"],
      "src-bad-nan": Number.NaN,
    } as unknown as ActiveSourcesMap;
    const plainBadSiblingMap = new Map<string, unknown>([
      ["src-ch-1", { version: "v1", active: true }],
      ["src-ch-2", { version: "v1", active: true }],
      ["src-ch-3", { version: "v1", active: true }],
      ["src-bad-obj", { version: "v1", active: {} }],
      ["src-bad-arr", { version: "v1", revoked: [] }],
      ["src-bad-str", { version: "v1", active: "yes" }],
      ["src-bad-blank", { version: "" }],
      ["src-bad-null", null],
      ["src-bad-bool", true],
      ["src-bad-list", ["v1"]],
      ["src-bad-nan", Number.NaN],
    ]) as unknown as ActiveSourcesMap;

    for (const plainBadSiblingSources of [plainBadSiblingRecord, plainBadSiblingMap]) {
      const inspected = inspectActiveSourcesMap(plainBadSiblingSources);
      expect(inspected.containerValid).toBe(true);
      expect(inspected.sources.size).toBe(3);
      expect(snapshotActiveSourcesMap(plainBadSiblingSources).size).toBe(3);
      expect(isSourceRefActive({ sourceId: "src-bad-obj", sourceVersion: "v1" }, plainBadSiblingSources)).toBe(false);
      expect(isSourceRefActive({ sourceId: "src-bad-arr", sourceVersion: "v1" }, plainBadSiblingSources)).toBe(false);
      expect(isSourceRefActive({ sourceId: "src-bad-str", sourceVersion: "v1" }, plainBadSiblingSources)).toBe(false);
      expect(isSourceRefActive({ sourceId: "src-bad-blank", sourceVersion: "" }, plainBadSiblingSources)).toBe(false);
      expect(isSourceRefActive({ sourceId: "src-ch-1", sourceVersion: "v1" }, plainBadSiblingSources)).toBe(true);

      const genWithPlainBadSibling = generateRemedyClinic({
        learnerId: "learner-1",
        courseId: "course-alg-1",
        ruleId: RULE_ID,
        currentPrivacyEpoch: 5,
        activeSourcesMap: plainBadSiblingSources,
        verifyRuleViolation: verifyNegativeSignFlip,
        attempts: baseAttempts,
        candidateProbes: [probe1, probe2],
      });
      expect(genWithPlainBadSibling.status).toBe("active");
      expect(genWithPlainBadSibling.clinic).not.toBeNull();

      const siblingReval = revalidateRemedyClinic(clinic, plainBadSiblingSources, 6);
      expect(siblingReval.status).toBe("active");
      expect(siblingReval.evidenceCases).toHaveLength(3);
    }

    // 2) Hostile JS traps (entry getter, throwing entry getter, per-entry Proxy, outer Record Proxy
    //    containing a bad sibling, and self-detaching nested Proxy) fail closed at container level
    //    in BOTH snapshotActiveSourcesMap (size === 0) AND generateRemedyClinic ("invalid_input") with
    //    ZERO getter executions.
    let hostileGetterRuns = 0;
    const getterFlagEntry = Object.defineProperty({ version: "v1" }, "active", {
      enumerable: true,
      get() {
        hostileGetterRuns += 1;
        return true;
      },
    });
    const throwingGetterEntry = Object.defineProperty({ version: "v1" }, "revoked", {
      enumerable: true,
      get() {
        hostileGetterRuns += 1;
        throw new Error("boom-entry-getter");
      },
    });
    const entryProxy = new Proxy({ version: "v1", active: true }, {});
    const outerProxyWithBadSibling = new Proxy(
      {
        "src-ch-1": { version: "v1", active: true },
        "src-ch-2": { version: "v1", active: true },
        "src-ch-3": { version: "v1", active: true },
        "src-bad-obj": { version: "v1", active: {} },
      },
      {},
    );
    const outerProxyWithGetterSibling = new Proxy(
      {
        "src-ch-1": { version: "v1", active: true },
        "src-ch-2": { version: "v1", active: true },
        "src-ch-3": { version: "v1", active: true },
        "src-bad-getter": getterFlagEntry,
      },
      {},
    );
    const detachEntryHolder: Record<string, unknown> = {
      "src-ch-1": { version: "v1", active: true },
      "src-ch-2": { version: "v1", active: true },
      "src-ch-3": { version: "v1", active: true },
    };
    const detachEntryObj: Record<string, unknown> = { version: "v1", active: null };
    let detachEntryFired = false;
    detachEntryObj["active"] = new Proxy(
      { nested: 1 },
      {
        getOwnPropertyDescriptor(target, prop) {
          if (!detachEntryFired && prop === "nested") {
            detachEntryFired = true;
            detachEntryObj["active"] = {};
            Object.defineProperty(detachEntryHolder, "injectedTrap", {
              enumerable: true,
              configurable: true,
              get() {
                hostileGetterRuns += 1;
                return "v1";
              },
            });
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      },
    );
    detachEntryHolder["src-detach"] = detachEntryObj;

    const hostileContainers: ActiveSourcesMap[] = [
      {
        "src-ch-1": { version: "v1", active: true },
        "src-ch-2": { version: "v1", active: true },
        "src-ch-3": { version: "v1", active: true },
        "src-bad-getter": getterFlagEntry,
      } as unknown as ActiveSourcesMap,
      new Map<string, unknown>([
        ["src-ch-1", { version: "v1", active: true }],
        ["src-ch-2", { version: "v1", active: true }],
        ["src-ch-3", { version: "v1", active: true }],
        ["src-bad-throw", throwingGetterEntry],
      ]) as unknown as ActiveSourcesMap,
      {
        "src-ch-1": { version: "v1", active: true },
        "src-ch-2": { version: "v1", active: true },
        "src-ch-3": { version: "v1", active: true },
        "src-entry-proxy": entryProxy,
      } as unknown as ActiveSourcesMap,
      outerProxyWithBadSibling as unknown as ActiveSourcesMap,
      outerProxyWithGetterSibling as unknown as ActiveSourcesMap,
      detachEntryHolder as unknown as ActiveSourcesMap,
    ];

    for (const hostileSources of hostileContainers) {
      const inspected = inspectActiveSourcesMap(hostileSources);
      expect(inspected.containerValid).toBe(false);
      expect(inspected.sources.size).toBe(0);
      expect(snapshotActiveSourcesMap(hostileSources).size).toBe(0);
      expect(isSourceRefActive({ sourceId: "src-ch-1", sourceVersion: "v1" }, hostileSources)).toBe(false);

      const hostileGen = generateRemedyClinic({
        learnerId: "learner-1",
        courseId: "course-alg-1",
        ruleId: RULE_ID,
        currentPrivacyEpoch: 5,
        activeSourcesMap: hostileSources,
        verifyRuleViolation: verifyNegativeSignFlip,
        attempts: baseAttempts,
        candidateProbes: [probe1, probe2],
      });
      expect(hostileGen.status).toBe("invalid_input");
      expect(hostileGen.clinic).toBeNull();

      const hostileReval = revalidateRemedyClinic(clinic, hostileSources, 6);
      expect(hostileReval.status).toBe("stale_source_revoked");
    }
    expect(hostileGetterRuns).toBe(0);

    // Round-14 [P1-1]: Self-detaching Proxy element inside sourceRefs fails closed with zero getter calls.
    let refDetachGetterRuns = 0;
    const validRef0 = { sourceId: "src-ch-1", sourceVersion: "v1" };
    const selfDetachingRefs: Array<{ sourceId: string; sourceVersion: string }> = [validRef0];
    let refDetached = false;
    selfDetachingRefs.push(
      new Proxy(
        { sourceId: "src-ch-2", sourceVersion: "v1" },
        {
          getOwnPropertyDescriptor(target, prop) {
            if (!refDetached && prop === "sourceId") {
              refDetached = true;
              selfDetachingRefs[1] = { sourceId: "src-ch-2", sourceVersion: "v1" };
              Object.defineProperty(validRef0, "injectedTrap", {
                enumerable: true,
                configurable: true,
                get() {
                  refDetachGetterRuns += 1;
                  return "boom";
                },
              });
            }
            return Reflect.getOwnPropertyDescriptor(target, prop);
          },
        },
      ),
    );
    expect(areSourceRefsActive(selfDetachingRefs, allSources)).toBe(false);
    expect(cloneSourceRefs(selfDetachingRefs)).toEqual([]);
    expect(refDetachGetterRuns).toBe(0);

    // Round-13 [P1-3] + Round-14 [P1-4]: computeEvidenceCoverage validates full ClinicEvidenceCase
    // completeness (attemptId, rootAttemptId, chapterId, localDate, ruleId, excerpt, invariantSummary,
    // privacyEpoch >= 0, and non-empty valid sourceRefs with no null/blank entries).
    const sameChapterDayBase = [
      { ...clinic.evidenceCases[0]!, rootAttemptId: "r1", chapterId: "ch-1", localDate: "2026-10-01" },
      { ...clinic.evidenceCases[1]!, rootAttemptId: "r2", chapterId: "ch-1", localDate: "2026-10-01" },
      { ...clinic.evidenceCases[2]!, rootAttemptId: "r3", chapterId: "ch-1", localDate: "2026-10-01" },
    ];
    const incompleteSecondChapterRows = [
      { ...clinic.evidenceCases[2]!, rootAttemptId: "   ", chapterId: "ch-2", localDate: "2026-10-09" },
      { ...clinic.evidenceCases[2]!, rootAttemptId: "r4", chapterId: "ch-2", localDate: "2026-10-09", privacyEpoch: -1 },
      { ...clinic.evidenceCases[2]!, rootAttemptId: "r5", chapterId: "ch-2", localDate: "2026-10-09", excerpt: "   " },
      { ...clinic.evidenceCases[2]!, rootAttemptId: "r6", chapterId: "ch-2", localDate: "2026-10-09", invariantSummary: "" },
      { ...clinic.evidenceCases[2]!, rootAttemptId: "r7", chapterId: "ch-2", localDate: "2026-10-09", sourceRefs: [] },
      {
        ...clinic.evidenceCases[2]!,
        rootAttemptId: "r8",
        chapterId: "ch-2",
        localDate: "2026-10-09",
        sourceRefs: [
          { sourceId: "src-ch-2", sourceVersion: "v1" },
          null as unknown as { sourceId: string; sourceVersion: string },
        ],
      },
      {
        ...clinic.evidenceCases[2]!,
        rootAttemptId: "r9",
        chapterId: "ch-2",
        localDate: "2026-10-09",
        sourceRefs: [{ sourceId: "   ", sourceVersion: "v1" }],
      },
    ];
    for (const incompleteRow of incompleteSecondChapterRows) {
      const cov = computeEvidenceCoverage([...sameChapterDayBase, incompleteRow]);
      expect(cov).toEqual({
        rootAttemptCount: 3,
        chapterCount: 1,
        localDateCount: 1,
      });
      expect(meetsClinicThreshold(cov)).toBe(false);
    }

    // Round-13 [P1-3 Defect B]: Whitespace-padded rootAttemptId " r1 " deduplicates identically with "r1"
    // in generateRemedyClinic so a retry carrying the sole 2nd chapter/day cannot bypass deduplication.
    const whitespaceRetryAttempts = [
      makeAttempt({ attemptId: "a1", rootAttemptId: "r1", chapterId: "ch-1", localDate: "2026-10-01", sourceRefs: [{ sourceId: "src-ch-1", sourceVersion: "v1" }] }),
      makeAttempt({ attemptId: "a2", rootAttemptId: "r2", chapterId: "ch-1", localDate: "2026-10-01", sourceRefs: [{ sourceId: "src-ch-1", sourceVersion: "v1" }] }),
      makeAttempt({ attemptId: "a3", rootAttemptId: "r3", chapterId: "ch-1", localDate: "2026-10-01", sourceRefs: [{ sourceId: "src-ch-1", sourceVersion: "v1" }] }),
      makeAttempt({ attemptId: "a4", rootAttemptId: " r1 ", chapterId: "ch-2", localDate: "2026-10-09", sourceRefs: [{ sourceId: "src-ch-2", sourceVersion: "v1" }] }),
    ];
    const whitespaceRetryRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: whitespaceRetryAttempts,
      candidateProbes: [probe1, probe2],
    });
    expect(whitespaceRetryRes.status).toBe("threshold_not_met");
    expect(whitespaceRetryRes.rejectedCounts.duplicateRoot).toBe(1);
    expect(whitespaceRetryRes.coverage).toEqual({
      rootAttemptCount: 3,
      chapterCount: 1,
      localDateCount: 1,
    });

    // Trimmed canonical IDs emitted by generateRemedyClinic survive revalidateRemedyClinic unchanged,
    // and revalidateRemedyClinic normalizes whitespace-padded clinic.ruleId / delayedRecheck.ruleId consistently.
    const paddedValidAttempts = [
      makeAttempt({ attemptId: " a1 ", rootAttemptId: " r1 ", chapterId: " ch-1 ", localDate: "2026-10-01", ruleId: ` ${RULE_ID} `, sourceRefs: [{ sourceId: "src-ch-1", sourceVersion: "v1" }] }),
      makeAttempt({ attemptId: " a2 ", rootAttemptId: " r2 ", chapterId: " ch-2 ", localDate: "2026-10-03", ruleId: ` ${RULE_ID} `, sourceRefs: [{ sourceId: "src-ch-2", sourceVersion: "v1" }] }),
      makeAttempt({ attemptId: " a3 ", rootAttemptId: " r3 ", chapterId: " ch-3 ", localDate: "2026-10-05", ruleId: ` ${RULE_ID} `, sourceRefs: [{ sourceId: "src-ch-3", sourceVersion: "v1" }] }),
    ];
    const paddedGenRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: ` ${RULE_ID} `,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts: paddedValidAttempts,
      candidateProbes: [probe1, probe2],
    });
    expect(paddedGenRes.status).toBe("active");
    expect(paddedGenRes.clinic!.ruleId).toBe(RULE_ID);
    expect(paddedGenRes.clinic!.evidenceCases.map((c) => c.rootAttemptId)).toEqual(["r1", "r2", "r3"]);
    const paddedReval = revalidateRemedyClinic(
      {
        ...paddedGenRes.clinic!,
        ruleId: ` ${RULE_ID} `,
        delayedRecheck: { ...paddedGenRes.clinic!.delayedRecheck, ruleId: ` ${RULE_ID} ` },
      },
      allSources,
      5,
    );
    expect(paddedReval.status).toBe("active");
    expect(paddedReval.ruleId).toBe(RULE_ID);
    expect(paddedReval.delayedRecheck.ruleId).toBe(RULE_ID);
    expect(paddedReval.steps[1].ruleId).toBe(RULE_ID);
    expect(paddedReval.evidenceCases.map((c) => c.rootAttemptId)).toEqual(["r1", "r2", "r3"]);
  });
});
