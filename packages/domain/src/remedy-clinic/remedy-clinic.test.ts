import { describe, expect, it } from "vitest";
import type { DistinguishableProbeSpec } from "../opening/cartridges/probe-protocol";
import {
  generateRemedyClinic,
  revalidateRemedyClinic,
  type ActiveSourcesMap,
  type DiagnosedRootAttempt,
} from "./index";

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
}): DistinguishableProbeSpec<InequalityInput, string> {
  return {
    probeId: options.probeId,
    requirementKey: "alg.linear-inequalities",
    prompt: `Solve ${options.input.a}x <= ${options.input.b} for x.`,
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

  function createFourCaseClinic() {
    const generated = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: {
        "src-revokable": "v1",
        "src-ch-1": "v1",
        "src-ch-2": "v1",
        "src-ch-3": "v1",
      },
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
      ],
    });
    expect(generated.status).toBe("active");
    return generated.clinic!;
  }

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
    expect(getterRes.status).toBe("insufficient_distinguishable_probes");
    expect(getterRes.rejectedProbes[0]!.reason).toBe("invalid_probe_descriptor");

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
    expect(slotHypRes.status).toBe("insufficient_distinguishable_probes");
    expect(slotHypRes.rejectedProbes[0]!.reason).toBe("invalid_probe_descriptor");

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

    // 35-level shared diamond DAG + cyclic plain input pass in linear O(V+E) time without throwing.
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

    const makeGraphProbe = (probeId: string, graphInput: GraphInput): DistinguishableProbeSpec<GraphInput, string> => ({
      probeId,
      requirementKey: "alg.linear-inequalities",
      prompt: `Graph solve ${graphInput.a}x <= ${graphInput.b}`,
      input: graphInput,
      correctModel: { id: "M_star", label: "Flip", role: "correct", predict: (x) => `x >= ${x.b / x.a}` },
      hypotheses: [
        { id: RULE_ID, label: "No flip", role: "misconception", description: "No flip", predict: (x) => `x <= ${x.b / x.a}` },
        { id: "rhs_abs", label: "Abs", role: "misconception", description: "Abs", predict: (x) => `x <= ${x.b / Math.abs(x.a)}` },
      ],
      observableKey: (s) => s,
      parseResponse: (r) => (typeof r === "string" ? r : null),
    });

    const graphRes = generateRemedyClinic({
      learnerId: "learner-1",
      courseId: "course-alg-1",
      ruleId: RULE_ID,
      currentPrivacyEpoch: 5,
      activeSourcesMap: allSources,
      verifyRuleViolation: verifyNegativeSignFlip,
      attempts,
      candidateProbes: [
        makeGraphProbe("probe-diamond-35", diamond),
        makeGraphProbe("probe-cyclic-self", cyclic),
      ],
    });
    expect(graphRes.status).toBe("active");
    expect(graphRes.clinic!.steps[2].probes).toHaveLength(2);
  });
});
