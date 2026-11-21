import { describe, expect, it } from "vitest";
import {
  ALLOWED_SCRATCHPAD_MIME_TYPES,
  BASE_PRIOR_ALPHA,
  BASE_PRIOR_BETA,
  COMPANION_ALLOWED_ACTIONS,
  COMPANION_FORBIDDEN_ACTIONS,
  COMPANION_PAIRING_TTL_MS,
  FORBIDDEN_MISS_VARIANT_FIELDS,
  MAX_BRIDGE_PRIOR_MEAN,
  MAX_BRIDGE_PSEUDO_OBSERVATIONS,
  MAX_BRIDGE_WEIGHT,
  MAX_OFFLINE_LEASE_CARDS,
  MAX_SCRATCHPAD_PAGE_BYTES,
  MIN_BRIDGE_PRIOR_MEAN,
  MIN_DIRECT_OBSERVATIONS_FOR_BRIDGE,
  OFFLINE_LEASE_TTL_MS,
  appendCompanionScratchpadPage,
  areCompanionOriginsIsolated,
  authorizeCompanionAction,
  canonicalizeIdentifier,
  canonicalizeMathNotation,
  computeCrossCourseWeakPrior,
  containsAnswerLeak,
  createCompanionPairingOffer,
  createCompanionScratchpadDraft,
  createInitialOfflineFsrsSnapshot,
  deriveCompanionFragmentSecretProof,
  extractRegistrableSite,
  formatCompanionUserCodeFromBytes,
  freezeCompanionScratchpadForSubmit,
  hasForbiddenMissVariantFields,
  issueOfflineFlashcardLease,
  normalizeCompanionUserCode,
  normalizeOrigin,
  offlineOutboxIdempotencyKey,
  parseCompanionQrUrl,
  reconcileOfflineLeaseOutbox,
  redeemCompanionPairingOffer,
  revokeCompanionSession,
  revokeOfflineFlashcardLease,
  type OfflineLeaseCardCandidate,
  type ServerFlashcardSnapshot,
} from "./index";

const T0 = Date.UTC(2026, 10, 21, 8, 0, 0);

function makeFlashcardCandidate(index: number): OfflineLeaseCardCandidate {
  return {
    cardId: `card-${index}`,
    cardKind: "flashcard",
    cardRevision: 1,
    lastServerReviewedAtMs: T0 - 86_400_000,
    prompt: `Define concept ${index}`,
    backSummary: `Concise summary ${index}`,
    internalSecretExtra: "should-be-stripped",
  };
}

function makeMissVariantCandidate(overrides: Record<string, unknown> = {}): OfflineLeaseCardCandidate {
  return {
    cardId: "miss-card-1",
    cardKind: "miss_variant",
    cardRevision: 3,
    lastServerReviewedAtMs: T0 - 7_200_000,
    freshVariantId: "variant-fresh-99",
    freshVariantStem: "Compute the determinant of [[4, 3], [5, 6]] without looking at notes.",
    answerKey: "1",
    canonicalSolution: "det = 2*3 - 1*5 = 1",
    gradingRubric: "Award full credit for showing 2*3 - 1*5 = 1",
    sealedPayload: { examId: "midterm-1", sealedSolutionToken: "SEALED_SECRET_TOKEN_XYZ" },
    referenceAnswer: "The determinant equals 1.",
    ...overrides,
  } as OfflineLeaseCardCandidate;
}

describe("Offline Flashcard Lease & Idempotent Outbox (Wave R / Lane R4-A)", () => {
  it("enforces constants, 1..30 cardinality, 12h TTL, and single-active supersession per (workspaceId, learnerId)", () => {
    expect(MAX_OFFLINE_LEASE_CARDS).toBe(30);
    expect(OFFLINE_LEASE_TTL_MS).toBe(43_200_000);

    const empty = issueOfflineFlashcardLease({
      leaseId: "lease-empty",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [],
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("empty_lease_cards");

    const tooMany = issueOfflineFlashcardLease({
      leaseId: "lease-31",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: Array.from({ length: 31 }, (_, i) => makeFlashcardCandidate(i + 1)),
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.code).toBe("lease_card_limit_exceeded");

    const first = issueOfflineFlashcardLease({
      leaseId: "lease-1",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: Array.from({ length: 30 }, (_, i) => makeFlashcardCandidate(i + 1)),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected first lease to succeed");
    expect(first.lease.expiresAtMs).toBe(T0 + OFFLINE_LEASE_TTL_MS);
    expect(first.lease.cards).toHaveLength(30);
    expect(first.supersededLeaseId).toBeNull();
    expect(first.supersededLease).toBeNull();
    expect(Object.keys(first.lease.cards[0]!).sort()).toEqual([
      "backSummary",
      "cardId",
      "cardKind",
      "cardRevision",
      "lastServerReviewedAtMs",
      "prompt",
    ]);

    const second = issueOfflineFlashcardLease({
      leaseId: "lease-2",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0 + 60_000,
      candidates: [makeFlashcardCandidate(1)],
      existingActiveLease: first.lease,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected second lease to succeed");
    expect(second.supersededLeaseId).toBe("lease-1");
    expect(second.supersededLease?.status).toBe("superseded");
    expect(second.supersededLease?.supersededByLeaseId).toBe("lease-2");
    expect(second.lease.status).toBe("active");

    const crossLearnerSupersede = issueOfflineFlashcardLease({
      leaseId: "lease-3",
      workspaceId: "ws-1",
      learnerId: "learner-2",
      issuedAtMs: T0 + 120_000,
      candidates: [makeFlashcardCandidate(1)],
      existingActiveLease: second.lease,
    });
    expect(crossLearnerSupersede.ok).toBe(false);
    if (!crossLearnerSupersede.ok) expect(crossLearnerSupersede.code).toBe("supersede_scope_mismatch");
  });

  it("sanitizes miss_variant cards with zero answer-key leak and fails closed on missing or leaked stems", () => {
    const minted = issueOfflineFlashcardLease({
      leaseId: "lease-miss-ok",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [makeMissVariantCandidate()],
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) throw new Error("expected miss variant lease to succeed");

    const card = minted.lease.cards[0]!;
    expect(card.cardKind).toBe("miss_variant");
    expect(hasForbiddenMissVariantFields(card)).toBe(false);
    expect(Object.keys(card).sort()).toEqual([
      "cardId",
      "cardKind",
      "cardRevision",
      "freshVariantId",
      "freshVariantStem",
      "lastServerReviewedAtMs",
    ]);
    for (const forbidden of FORBIDDEN_MISS_VARIANT_FIELDS) {
      expect(card).not.toHaveProperty(forbidden);
    }

    const missingStem = issueOfflineFlashcardLease({
      leaseId: "lease-miss-empty",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [makeMissVariantCandidate({ freshVariantStem: "   " })],
    });
    expect(missingStem.ok).toBe(false);
    if (!missingStem.ok) expect(missingStem.code).toBe("miss_variant_stem_required");

    const leakedAnswerKey = issueOfflineFlashcardLease({
      leaseId: "lease-miss-leak-answer",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        makeMissVariantCandidate({
          answerKey: "x = 7",
          freshVariantStem: "  X = 7 ",
        }),
      ],
    });
    expect(leakedAnswerKey.ok).toBe(false);
    if (!leakedAnswerKey.ok) expect(leakedAnswerKey.code).toBe("miss_variant_answer_leak");

    const leakedCanonical = issueOfflineFlashcardLease({
      leaseId: "lease-miss-leak-canonical",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        makeMissVariantCandidate({
          freshVariantStem: "det = 2*3 - 1*5 = 1",
        }),
      ],
    });
    expect(leakedCanonical.ok).toBe(false);
    if (!leakedCanonical.ok) expect(leakedCanonical.code).toBe("miss_variant_answer_leak");

    const leakedSealed = issueOfflineFlashcardLease({
      leaseId: "lease-miss-leak-sealed",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        makeMissVariantCandidate({
          sealedPayload: "SEALED_SECRET_TOKEN_XYZ",
          freshVariantStem: "Hint: SEALED_SECRET_TOKEN_XYZ",
        }),
      ],
    });
    expect(leakedSealed.ok).toBe(false);
    if (!leakedSealed.ok) expect(leakedSealed.code).toBe("miss_variant_answer_leak");

    // [P1-1] Embedded substring solutions, algebraic answers, and solution directive markers MUST fail closed.
    const embeddedLeaks: ReadonlyArray<Record<string, unknown>> = [
      {
        freshVariantStem:
          "Compute the determinant of [[2, 1], [5, 3]]. Working: det = 2*3 - 1*5 = 1.",
      },
      {
        answerKey: "x = 7",
        freshVariantStem: "Solve 2x = 14 (check that x=7 satisfies the equation).",
      },
      {
        answerKey: "O(n log n)",
        freshVariantStem: "Find the merge sort runtime; recall O(n log n) dominates.",
      },
      {
        freshVariantStem: "Solve 2x = 6.\n\\begin{solution}\nx = 3\n\\end{solution}",
      },
      {
        freshVariantStem: "Solve 2x = 6.\n:::solution\nx = 3\n:::",
      },
      {
        freshVariantStem: "Solve 2x = 6. <details><summary>Check</summary>3</details>",
      },
      {
        freshVariantStem: "Solve 2x = 6. [Answer: 3]",
      },
      {
        freshVariantStem: "Solve 2x = 6. Answer: 3",
      },
      {
        freshVariantStem: "计算行列式的值。解析：2*3 - 1*5 = 1",
      },
      {
        freshVariantStem: "计算行列式的值。答案：1",
      },
      {
        freshVariantStem: "Solve 2x = 6. **Answer:** 3",
      },
      {
        freshVariantStem: "Solve 2x = 6. **Solution**: x = 3",
      },
      {
        freshVariantStem: "Solve 2x = 6. __Answer__ 3",
      },
      {
        freshVariantStem: "Solve 2x = 6. *Answer:* 3",
      },
      {
        freshVariantStem: "计算行列式。答案=1",
      },
      {
        freshVariantStem: "计算行列式。解：det = 1",
      },
    ];
    for (const [idx, leakOverrides] of embeddedLeaks.entries()) {
      const rejected = issueOfflineFlashcardLease({
        leaseId: `lease-miss-embedded-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [makeMissVariantCandidate(leakOverrides)],
      });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.httpStatus).toBe(422);
        expect(rejected.code).toBe("miss_variant_answer_leak");
      }
    }

    // Benign prose mentioning "*answer*" without a solution directive must NOT false-positive.
    const benignMiss = issueOfflineFlashcardLease({
      leaseId: "lease-miss-benign-italics",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        makeMissVariantCandidate({
          freshVariantStem: "Use the *answer* from part (a) to compute the trace of B.",
        }),
      ],
    });
    expect(benignMiss.ok).toBe(true);

    // Defense-in-depth: "flashcard" candidates carrying sealed/answer-key fields or directive prompts MUST fail closed.
    for (const forbiddenField of FORBIDDEN_MISS_VARIANT_FIELDS) {
      const rejectedFlashcard = issueOfflineFlashcardLease({
        leaseId: `lease-fc-forbidden-${forbiddenField}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          {
            ...makeFlashcardCandidate(1),
            [forbiddenField]: forbiddenField === "sealedPayload" ? { secret: "tok" } : "secret-val",
          },
        ],
      });
      expect(rejectedFlashcard.ok).toBe(false);
      if (!rejectedFlashcard.ok) {
        expect(rejectedFlashcard.httpStatus).toBe(422);
        expect(rejectedFlashcard.code).toBe("miss_variant_answer_leak");
      }
    }

    const directiveFlashcard = issueOfflineFlashcardLease({
      leaseId: "lease-fc-directive",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        {
          ...makeFlashcardCandidate(1),
          prompt: "Compute 2x = 6. **Answer:** 3",
        },
      ],
    });
    expect(directiveFlashcard.ok).toBe(false);
    if (!directiveFlashcard.ok) {
      expect(directiveFlashcard.httpStatus).toBe(422);
      expect(directiveFlashcard.code).toBe("miss_variant_answer_leak");
    }

    // [P1-1] Check backSummary on flashcards against directives AND sibling sealed/answer secrets,
    // AND check short single-token answers ("42", "-7", "0.5", "pi/2", "x=5", choice "B") in miss_variant stems!
    const backSummaryDirective = issueOfflineFlashcardLease({
      leaseId: "lease-fc-backsummary-directive",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        {
          ...makeFlashcardCandidate(1),
          backSummary: "Answer: 42",
        },
      ],
    });
    expect(backSummaryDirective.ok).toBe(false);
    if (!backSummaryDirective.ok) {
      expect(backSummaryDirective.httpStatus).toBe(422);
      expect(backSummaryDirective.code).toBe("miss_variant_answer_leak");
    }

    const backSummarySiblingLeak = issueOfflineFlashcardLease({
      leaseId: "lease-fc-backsummary-sibling-leak",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        makeMissVariantCandidate(),
        {
          ...makeFlashcardCandidate(2),
          backSummary: "Remember SEALED_SECRET_TOKEN_XYZ from the exam.",
        },
      ],
    });
    expect(backSummarySiblingLeak.ok).toBe(false);
    if (!backSummarySiblingLeak.ok) {
      expect(backSummarySiblingLeak.httpStatus).toBe(422);
      expect(backSummarySiblingLeak.code).toBe("miss_variant_answer_leak");
    }

    // [Round-5 P1-1] Short-token sibling miss_variant answers ("42", "-7", "0.5", "pi/2", "x=5", choice "B")
    // embedded in a sibling flashcard's prompt OR backSummary MUST fail closed with 422 miss_variant_answer_leak.
    for (const [idx, siblingLeak] of [
      { answerKey: "42", prompt: "Define trace of M.", backSummary: "For the exam matrix it equals 42." },
      { answerKey: "-7", prompt: "Recall why f(2) gives -7.", backSummary: "Apply the linear formula." },
      { answerKey: "0.5", prompt: "Define Bernoulli variance.", backSummary: "At p = 0.5 variance peaks." },
      { answerKey: "pi/2", prompt: "Orthogonal angle reminder.", backSummary: "Right angles measure pi/2." },
      { answerKey: "x=5", prompt: "Verify x = 5 on linear systems.", backSummary: "Check substitution." },
      { answerKey: "B", prompt: "Review orthogonal basis criteria.", backSummary: "Correct option is B." },
    ].entries()) {
      const rejectedSiblingShort = issueOfflineFlashcardLease({
        leaseId: `lease-fc-sibling-short-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({ answerKey: siblingLeak.answerKey }),
          {
            ...makeFlashcardCandidate(10 + idx),
            prompt: siblingLeak.prompt,
            backSummary: siblingLeak.backSummary,
          },
        ],
      });
      expect(rejectedSiblingShort.ok).toBe(false);
      if (!rejectedSiblingShort.ok) {
        expect(rejectedSiblingShort.httpStatus).toBe(422);
        expect(rejectedSiblingShort.code).toBe("miss_variant_answer_leak");
      }
    }

    // Clean flashcard alongside a sibling miss_variant with short answerKey "42" still succeeds.
    const cleanSiblingLease = issueOfflineFlashcardLease({
      leaseId: "lease-fc-sibling-clean",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        makeMissVariantCandidate({ answerKey: "42" }),
        {
          ...makeFlashcardCandidate(99),
          prompt: "Define orthogonality of two vectors.",
          backSummary: "Their inner product equals zero.",
        },
      ],
    });
    expect(cleanSiblingLease.ok).toBe(true);

    // [Round-6 P1] Symmetric Unicode math-notation canonicalization in short-token leak detection:
    // catches "π/2" (vs both "π/2" and "pi/2"), "−7" (\u2212), "√2" (vs both "√2" and "sqrt(2)"),
    // "±3", "½", "θ/4", "2×3", "x≤5", "x≥0", "x≠1", and "∞" in flashcard prompt/backSummary.
    expect(containsAnswerLeak("The angle is π/2 radians.", "π/2")).toBe(true);
    expect(containsAnswerLeak("The angle is π/2 radians.", "pi/2")).toBe(true);
    expect(containsAnswerLeak("The angle is pi/2 radians.", "π/2")).toBe(true);
    expect(containsAnswerLeak("Evaluate f(2), expected \u22127.", "-7")).toBe(true);
    expect(containsAnswerLeak("Evaluate f(2), expected -7.", "\u22127")).toBe(true);
    expect(containsAnswerLeak("The diagonal length is √2 units.", "√2")).toBe(true);
    expect(containsAnswerLeak("The diagonal length is √2 units.", "sqrt(2)")).toBe(true);
    expect(containsAnswerLeak("The diagonal length is sqrt2 units.", "√2")).toBe(true);
    expect(containsAnswerLeak("Symmetric roots are ±3.", "±3")).toBe(true);
    expect(containsAnswerLeak("Midpoint fraction equals ½.", "½")).toBe(true);
    expect(containsAnswerLeak("Midpoint fraction equals 1/2.", "½")).toBe(true);
    expect(containsAnswerLeak("Phase shift is θ/4.", "θ/4")).toBe(true);
    expect(containsAnswerLeak("Product evaluates to 2×3.", "2*3")).toBe(true);
    expect(containsAnswerLeak("Domain constraint x≤5 holds.", "x<=5")).toBe(true);
    expect(containsAnswerLeak("Non-negative bound x≥0 holds.", "x>=0")).toBe(true);
    expect(containsAnswerLeak("Exclude pole x≠1.", "x!=1")).toBe(true);
    expect(containsAnswerLeak("Sequence diverges to ∞.", "∞")).toBe(true);

    for (const [idx, unicodeLeak] of [
      { answerKey: "π/2", prompt: "Unit circle right angle.", backSummary: "Measured as π/2 radians." },
      { answerKey: "pi/2", prompt: "Recall π/2 on the unit circle.", backSummary: "Quarter turn." },
      { answerKey: "\u22127", prompt: "Signed integer shift.", backSummary: "Evaluates to \u22127 here." },
      { answerKey: "-7", prompt: "Check result \u22127.", backSummary: "Linear offset." },
      { answerKey: "√2", prompt: "Diagonal of unit square.", backSummary: "Length equals √2." },
      { answerKey: "sqrt(2)", prompt: "Remember √2 is irrational.", backSummary: "Proof by parity." },
      { answerKey: "±3", prompt: "Roots of x^2 = 9.", backSummary: "Solutions are ±3." },
      { answerKey: "½", prompt: "Exact value of sin(30 deg).", backSummary: "Equals ½." },
    ].entries()) {
      const rejectedUnicode = issueOfflineFlashcardLease({
        leaseId: `lease-fc-unicode-short-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({ answerKey: unicodeLeak.answerKey }),
          {
            ...makeFlashcardCandidate(200 + idx),
            prompt: unicodeLeak.prompt,
            backSummary: unicodeLeak.backSummary,
          },
        ],
      });
      expect(rejectedUnicode.ok).toBe(false);
      if (!rejectedUnicode.ok) {
        expect(rejectedUnicode.httpStatus).toBe(422);
        expect(rejectedUnicode.code).toBe("miss_variant_answer_leak");
      }
    }

    // [Round-7 P1-1] Spaced operators ("π / 2", "− 7", "± 3", "√ ( 2 )", "1 / 2") AND CJK prose
    // ("其值为π/2弧度。", "答案是 − 7 分", "等于 √ 2 倍") MUST be detected without false-positiving
    // on Latin identifiers ("api2", "api/2") or decimals ("3.14").
    expect(canonicalizeMathNotation("The angle is π / 2 radians")).toBe("the angle is pi/2 radians");
    expect(canonicalizeMathNotation("等于 √ ( 2 ) 倍")).toBe("等于 sqrt(2) 倍");
    expect(containsAnswerLeak("The angle is π / 2 radians", "π/2")).toBe(true);
    expect(containsAnswerLeak("The angle is π / 2 radians", "pi/2")).toBe(true);
    expect(containsAnswerLeak("其值为π/2弧度。", "π/2")).toBe(true);
    expect(containsAnswerLeak("其值为π/2弧度。", "pi/2")).toBe(true);
    expect(containsAnswerLeak("其值为 π / 2 弧度。", "π/2")).toBe(true);
    expect(containsAnswerLeak("答案是 \u2212 7 分", "-7")).toBe(true);
    expect(containsAnswerLeak("其值为\u22127分", "\u22127")).toBe(true);
    expect(containsAnswerLeak("等于 √ 2 倍", "√2")).toBe(true);
    expect(containsAnswerLeak("等于 √ ( 2 ) 倍", "sqrt(2)")).toBe(true);
    expect(containsAnswerLeak("对称根为 ± 3 。", "±3")).toBe(true);
    expect(containsAnswerLeak("比例是 1 / 2 处", "½")).toBe(true);
    expect(containsAnswerLeak("Use api2 endpoint", "2")).toBe(false);
    expect(containsAnswerLeak("Use api/2 endpoint", "pi/2")).toBe(false);
    expect(containsAnswerLeak("Value is 3.14", "14")).toBe(false);
    expect(containsAnswerLeak("Value is 3.14", "3")).toBe(false);
    expect(containsAnswerLeak("Solve x^2 - 4 = 0", "-4")).toBe(false);

    // [Round-8 P1] Binary `+`/`-` whitespace normalization across compound math/equation expressions
    // (`x = 2 + 3` <-> `x=2+3`, `a + b` <-> `a+b`, `2x - 1` <-> `2x-1`) in BOTH flashcard and miss_variant stems,
    // while keeping standalone signed literals (`"-4"`) non-false-positive on `"Solve x^2 - 4 = 0"`.
    expect(containsAnswerLeak("Check x=2+3 carefully.", "x = 2 + 3")).toBe(true);
    expect(containsAnswerLeak("Check x = 2 + 3 carefully.", "x=2+3")).toBe(true);
    expect(containsAnswerLeak("Evaluate a+b directly.", "a + b")).toBe(true);
    expect(containsAnswerLeak("Evaluate a + b directly.", "a+b")).toBe(true);
    expect(containsAnswerLeak("Remember 2x-1 vanishes.", "2x - 1")).toBe(true);
    expect(containsAnswerLeak("Remember 2x - 1 vanishes.", "2x-1")).toBe(true);
    expect(containsAnswerLeak("其解为x=2+3。", "x = 2 + 3")).toBe(true);

    for (const [idx, exprCase] of [
      { answerKey: "x = 2 + 3", stem: "Verify that x=2+3 satisfies the system." },
      { answerKey: "x=2+3", stem: "Verify that x = 2 + 3 satisfies the system." },
      { answerKey: "a + b", stem: "Recall that a+b stays invariant." },
      { answerKey: "2x - 1", stem: "Use the derivative 2x-1 here." },
    ].entries()) {
      const rejectedMiss = issueOfflineFlashcardLease({
        leaseId: `lease-r8-binary-miss-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: exprCase.answerKey,
            freshVariantStem: exprCase.stem,
          }),
        ],
      });
      expect(rejectedMiss.ok).toBe(false);
      if (!rejectedMiss.ok) {
        expect(rejectedMiss.httpStatus).toBe(422);
        expect(rejectedMiss.code).toBe("miss_variant_answer_leak");
      }

      const rejectedFlashcard = issueOfflineFlashcardLease({
        leaseId: `lease-r8-binary-fc-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({ answerKey: exprCase.answerKey }),
          {
            ...makeFlashcardCandidate(400 + idx),
            prompt: "Review algebraic form.",
            backSummary: exprCase.stem,
          },
        ],
      });
      expect(rejectedFlashcard.ok).toBe(false);
      if (!rejectedFlashcard.ok) {
        expect(rejectedFlashcard.httpStatus).toBe(422);
        expect(rejectedFlashcard.code).toBe("miss_variant_answer_leak");
      }
    }

    // Standalone signed literal "-4" must STILL not false-positive on binary subtraction "Solve x^2 - 4 = 0".
    const benignSignedLiteral = issueOfflineFlashcardLease({
      leaseId: "lease-r8-signed-benign",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        makeMissVariantCandidate({
          answerKey: "-4",
          freshVariantStem: "Solve x^2 - 4 = 0 for all real roots.",
        }),
      ],
    });
    expect(benignSignedLiteral.ok).toBe(true);

    for (const [idx, spacedOrCjk] of [
      { answerKey: "π/2", prompt: "Right-angle measure.", backSummary: "The angle is π / 2 radians" },
      { answerKey: "π/2", prompt: "直角弧度。", backSummary: "其值为π/2弧度。" },
      { answerKey: "-7", prompt: "计算结果。", backSummary: "其值为 \u2212 7 分" },
      { answerKey: "√2", prompt: "正方形对角线。", backSummary: "等于 √ 2 倍" },
    ].entries()) {
      const rejectedSpacedCjk = issueOfflineFlashcardLease({
        leaseId: `lease-r7-spaced-cjk-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({ answerKey: spacedOrCjk.answerKey }),
          {
            ...makeFlashcardCandidate(300 + idx),
            prompt: spacedOrCjk.prompt,
            backSummary: spacedOrCjk.backSummary,
          },
        ],
      });
      expect(rejectedSpacedCjk.ok).toBe(false);
      if (!rejectedSpacedCjk.ok) {
        expect(rejectedSpacedCjk.httpStatus).toBe(422);
        expect(rejectedSpacedCjk.code).toBe("miss_variant_answer_leak");
      }
    }

    // [Round-7 P1-2] Cross-miss-variant leak: miss_variant #2 MUST NOT expose miss_variant #1's answer!
    const crossMissLeak = issueOfflineFlashcardLease({
      leaseId: "lease-r7-cross-miss-leak",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        makeMissVariantCandidate({
          cardId: "miss-card-a",
          freshVariantId: "var-a",
          freshVariantStem: "Compute the determinant of [[4, 3], [5, 6]].",
          answerKey: "42",
        }),
        makeMissVariantCandidate({
          cardId: "miss-card-b",
          freshVariantId: "var-b",
          freshVariantStem: "Suppose a matrix has trace 42; compute its rank.",
          answerKey: "9",
          canonicalSolution: "rank = 9",
          gradingRubric: "Full credit for 9",
          referenceAnswer: "The rank is 9.",
          sealedPayload: { token: "OTHER_SEALED_TOKEN" },
        }),
      ],
    });
    expect(crossMissLeak.ok).toBe(false);
    if (!crossMissLeak.ok) {
      expect(crossMissLeak.httpStatus).toBe(422);
      expect(crossMissLeak.code).toBe("miss_variant_answer_leak");
    }

    const crossMissClean = issueOfflineFlashcardLease({
      leaseId: "lease-r7-cross-miss-clean",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        makeMissVariantCandidate({
          cardId: "miss-card-a",
          freshVariantId: "var-a",
          freshVariantStem: "Compute the determinant of [[4, 3], [5, 6]].",
          answerKey: "42",
        }),
        makeMissVariantCandidate({
          cardId: "miss-card-b",
          freshVariantId: "var-b",
          freshVariantStem: "Determine whether [[7, 8], [10, 11]] is invertible.",
          answerKey: "99",
          canonicalSolution: "invertible because det != 0",
          gradingRubric: "Show nonzero determinant",
          referenceAnswer: "Yes, invertible.",
          sealedPayload: { token: "CLEAN_OTHER_TOKEN" },
        }),
      ],
    });
    expect(crossMissClean.ok).toBe(true);

    expect(containsAnswerLeak("Compute the trace of M (result 42).", "42")).toBe(true);
    expect(containsAnswerLeak("Evaluate f(2), expected -7.", "-7")).toBe(true);
    expect(containsAnswerLeak("Compute probability (0.5).", "0.5")).toBe(true);
    expect(containsAnswerLeak("Evaluate arcsin(1) using pi/2.", "pi/2")).toBe(true);
    expect(containsAnswerLeak("Solve 3x = 15 (check x=5).", "x=5")).toBe(true);
    expect(containsAnswerLeak("Which eigenvalue is largest? Correct option is B.", "B")).toBe(true);
    expect(containsAnswerLeak("Which eigenvalue is largest? (B)", "B")).toBe(true);

    for (const [idx, shortLeak] of [
      { answerKey: "42", freshVariantStem: "Compute the trace of M (expected 42)." },
      { answerKey: "-7", freshVariantStem: "Find f(3) without computing -7 first." },
      { answerKey: "0.5", freshVariantStem: "Compute the probability (0.5)." },
      { answerKey: "pi/2", freshVariantStem: "Evaluate the angle around pi/2." },
      { answerKey: "x=5", freshVariantStem: "Solve 3x = 15 (hint x = 5)." },
      { answerKey: "B", freshVariantStem: "Which basis is orthogonal? (B)" },
    ].entries()) {
      const shortRejected = issueOfflineFlashcardLease({
        leaseId: `lease-miss-short-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [makeMissVariantCandidate(shortLeak)],
      });
      expect(shortRejected.ok).toBe(false);
      if (!shortRejected.ok) {
        expect(shortRejected.httpStatus).toBe(422);
        expect(shortRejected.code).toBe("miss_variant_answer_leak");
      }
    }
  });

  it("settles unordered outbox entries idempotently at serverReceiptAtMs, clamps easy->good, strips delayedCheck, and catches seq payload mismatch", () => {
    const minted = issueOfflineFlashcardLease({
      leaseId: "lease-settle-1",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [makeFlashcardCandidate(1), makeFlashcardCandidate(2)],
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) throw new Error("expected lease");

    const serverCards: Record<string, ServerFlashcardSnapshot> = {
      "card-1": createInitialOfflineFsrsSnapshot("card-1", T0 - 3_600_000, 1),
      "card-2": createInitialOfflineFsrsSnapshot("card-2", T0 - 3_600_000, 1),
    };

    const receiptAtMs = T0 + 2 * 3_600_000;
    const forgedFutureClientMs = T0 + 30 * 86_400_000;
    const forgedPastClientMs = T0 - 10 * 86_400_000;

    // Submit seq=2 before seq=1 to verify deterministic ordering, plus forged clocks and promotion flags.
    const firstPass = reconcileOfflineLeaseOutbox({
      lease: minted.lease,
      serverCards,
      serverReceiptAtMs: receiptAtMs,
      entries: [
        {
          leaseId: "lease-settle-1",
          seq: 2,
          cardId: "card-2",
          expectedCardRevision: 1,
          rating: "hard",
          clientReviewedAtMs: forgedPastClientMs,
          transferVerified: true,
        },
        {
          leaseId: "lease-settle-1",
          seq: 1,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "easy",
          clientReviewedAtMs: forgedFutureClientMs,
          delayedCheck: true,
          promoteMastery: true,
        },
      ],
    });

    expect(firstPass.ok).toBe(true);
    if (!firstPass.ok) throw new Error("expected settlement to succeed");
    expect(firstPass.settledCount).toBe(2);
    expect(firstPass.results.map(r => r.seq)).toEqual([1, 2]);

    const item1 = firstPass.results[0]!;
    expect(item1.outcome).toBe("settled");
    if (item1.outcome !== "settled") throw new Error("expected settled");
    expect(item1.effectiveRating).toBe("good");
    expect(item1.clampedFromEasy).toBe(true);
    expect(item1.authorityClock).toBe("server_receipt");
    expect(item1.effectiveReviewedAtMs).toBe(receiptAtMs);
    expect(item1.delayedCheckMinted).toBe(false);
    expect(item1.allowMasteryPromotion).toBe(false);
    expect(item1.transferVerified).toBe(false);
    expect(item1.receipt.strippedClientFlags).toEqual(["delayedCheck", "promoteMastery"]);
    expect(item1.receipt.nextSnapshot.lastServerReviewedAtMs).toBe(receiptAtMs);
    expect(item1.receipt.nextSnapshot.fsrs?.lastReviewAtMs).toBe(receiptAtMs);
    expect(item1.receipt.nextSnapshot.lastGrade).toBe("good");

    // Verify FSRS result is identical regardless of forged clientReviewedAtMs (strict serverReceiptAtMs authority).
    const baselineGood = reconcileOfflineLeaseOutbox({
      lease: minted.lease,
      serverCards,
      serverReceiptAtMs: receiptAtMs,
      entries: [
        {
          leaseId: "lease-settle-1",
          seq: 1,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "good",
          clientReviewedAtMs: receiptAtMs,
        },
      ],
    });
    expect(baselineGood.ok).toBe(true);
    if (!baselineGood.ok) throw new Error("expected baseline");
    expect(firstPass.updatedServerCards["card-1"]?.dueAtMs).toBe(
      baselineGood.updatedServerCards["card-1"]?.dueAtMs,
    );
    expect(firstPass.updatedServerCards["card-1"]?.fsrs).toEqual(
      baselineGood.updatedServerCards["card-1"]?.fsrs,
    );

    // Exact replay of (leaseId, seq=1) returns cached receipt with ZERO duplicate FSRS mutation.
    // Conflicting payload on (leaseId, seq=2) fails closed with 409 seq_payload_mismatch.
    const secondPass = reconcileOfflineLeaseOutbox({
      lease: minted.lease,
      serverCards: firstPass.updatedServerCards,
      processedLedger: firstPass.nextProcessedLedger,
      serverReceiptAtMs: receiptAtMs + 60_000,
      entries: [
        {
          leaseId: "lease-settle-1",
          seq: 1,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "easy",
          clientReviewedAtMs: forgedFutureClientMs,
          delayedCheck: true,
          promoteMastery: true,
        },
        {
          leaseId: "lease-settle-1",
          seq: 2,
          cardId: "card-2",
          expectedCardRevision: 1,
          rating: "again", // tampered rating for already-settled seq=2
          clientReviewedAtMs: forgedPastClientMs,
          transferVerified: true,
        },
      ],
    });
    expect(secondPass.ok).toBe(true);
    if (!secondPass.ok) throw new Error("expected second pass");
    expect(secondPass.settledCount).toBe(0);
    expect(secondPass.replayedCount).toBe(1);
    expect(secondPass.conflictCount).toBe(1);
    expect(secondPass.results[0]?.outcome).toBe("replayed");
    if (secondPass.results[0]?.outcome === "replayed") {
      expect(secondPass.results[0].effectiveReviewedAtMs).toBe(receiptAtMs);
      expect(secondPass.results[0].receipt.newRevision).toBe(2);
    }
    expect(secondPass.results[1]?.outcome).toBe("seq_payload_mismatch");
    expect(secondPass.results[1]?.httpStatus).toBe(409);
    expect(secondPass.updatedServerCards["card-1"]).toEqual(firstPass.updatedServerCards["card-1"]);
    expect(secondPass.updatedServerCards["card-2"]).toEqual(firstPass.updatedServerCards["card-2"]);
    expect(firstPass.nextProcessedLedger[offlineOutboxIdempotencyKey("lease-settle-1", 1)]?.payloadSummary).toEqual({
      cardId: "card-1",
      rating: "easy",
      expectedCardRevision: 1,
      clientReviewedAtMs: forgedFutureClientMs,
    });

    // [P1-2] Verify ANY single field difference (cardId, expectedCardRevision, clientReviewedAtMs)
    // on a repeated (leaseId, seq) fails closed with 409 seq_payload_mismatch.
    for (const mutatedEntry of [
      {
        leaseId: "lease-settle-1",
        seq: 1,
        cardId: "card-2", // different cardId reusing seq=1
        expectedCardRevision: 1,
        rating: "easy" as const,
        clientReviewedAtMs: forgedFutureClientMs,
        delayedCheck: true,
        promoteMastery: true,
      },
      {
        leaseId: "lease-settle-1",
        seq: 1,
        cardId: "card-1",
        expectedCardRevision: 2, // different expectedCardRevision
        rating: "easy" as const,
        clientReviewedAtMs: forgedFutureClientMs,
        delayedCheck: true,
        promoteMastery: true,
      },
      {
        leaseId: "lease-settle-1",
        seq: 1,
        cardId: "card-1",
        expectedCardRevision: 1,
        rating: "easy" as const,
        clientReviewedAtMs: forgedFutureClientMs + 1, // different clientReviewedAtMs
        delayedCheck: true,
        promoteMastery: true,
      },
    ]) {
      const conflictCheck = reconcileOfflineLeaseOutbox({
        lease: minted.lease,
        serverCards: firstPass.updatedServerCards,
        processedLedger: firstPass.nextProcessedLedger,
        serverReceiptAtMs: receiptAtMs + 120_000,
        entries: [mutatedEntry],
      });
      expect(conflictCheck.ok).toBe(true);
      if (!conflictCheck.ok) throw new Error("expected conflict response");
      expect(conflictCheck.results[0]).toMatchObject({
        outcome: "seq_payload_mismatch",
        httpStatus: 409,
      });
    }
  });

  it("rejects desktop review race (409 reviewed_elsewhere) and expired/superseded/revoked leases without mutating FSRS", () => {
    const minted = issueOfflineFlashcardLease({
      leaseId: "lease-race-1",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [makeFlashcardCandidate(1), makeFlashcardCandidate(2)],
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) throw new Error("expected lease");

    const card1Base = createInitialOfflineFsrsSnapshot("card-1", T0 - 3_600_000, 1);
    const card2Base = createInitialOfflineFsrsSnapshot("card-2", T0 - 3_600_000, 1);

    // card-1 had revision bumped on desktop; card-2 has lastServerReviewedAtMs > lease.issuedAtMs
    const racedCards: Record<string, ServerFlashcardSnapshot> = {
      "card-1": { ...card1Base, revision: 2 },
      "card-2": { ...card2Base, lastServerReviewedAtMs: T0 + 1_000 },
    };

    const raceResult = reconcileOfflineLeaseOutbox({
      lease: minted.lease,
      serverCards: racedCards,
      serverReceiptAtMs: T0 + 30_000,
      entries: [
        { leaseId: "lease-race-1", seq: 1, cardId: "card-1", expectedCardRevision: 1, rating: "good" },
        { leaseId: "lease-race-1", seq: 2, cardId: "card-2", expectedCardRevision: 1, rating: "good" },
      ],
    });
    expect(raceResult.ok).toBe(true);
    if (!raceResult.ok) throw new Error("expected reconciliation response");
    expect(raceResult.settledCount).toBe(0);
    expect(raceResult.conflictCount).toBe(2);
    expect(raceResult.results[0]).toMatchObject({
      outcome: "reviewed_elsewhere",
      httpStatus: 409,
      leasedCardRevision: 1,
    });
    expect(raceResult.results[1]).toMatchObject({
      outcome: "reviewed_elsewhere",
      httpStatus: 409,
      leasedCardRevision: 1,
    });
    expect(raceResult.updatedServerCards).toEqual(racedCards);

    // [P1-2] Desktop review occurring at the EXACT lease.issuedAtMs millisecond MUST fail closed
    // with 409 reviewed_elsewhere even if the offline client claims the newer server revision!
    const sameMsDesktopReviewed: Record<string, ServerFlashcardSnapshot> = {
      "card-1": { ...card1Base, revision: 2, lastServerReviewedAtMs: T0 },
    };
    const spoofedRevisionAttempt = reconcileOfflineLeaseOutbox({
      lease: minted.lease,
      serverCards: sameMsDesktopReviewed,
      serverReceiptAtMs: T0 + 30_000,
      entries: [
        {
          leaseId: "lease-race-1",
          seq: 1,
          cardId: "card-1",
          expectedCardRevision: 2, // client tries to match newer desktop revision
          rating: "good",
        },
      ],
    });
    expect(spoofedRevisionAttempt.ok).toBe(true);
    if (!spoofedRevisionAttempt.ok) throw new Error("expected reconcile response");
    expect(spoofedRevisionAttempt.settledCount).toBe(0);
    expect(spoofedRevisionAttempt.conflictCount).toBe(1);
    expect(spoofedRevisionAttempt.results[0]).toMatchObject({
      outcome: "reviewed_elsewhere",
      httpStatus: 409,
      serverRevision: 2,
      leasedCardRevision: 1,
      expectedCardRevision: 2,
    });
    expect(spoofedRevisionAttempt.updatedServerCards).toEqual(sameMsDesktopReviewed);

    // Backdated clientReviewedAtMs CANNOT bypass 12h expiry when serverReceiptAtMs > expiresAtMs.
    const expiredResult = reconcileOfflineLeaseOutbox({
      lease: minted.lease,
      serverCards: { "card-1": card1Base },
      serverReceiptAtMs: T0 + OFFLINE_LEASE_TTL_MS + 1,
      entries: [
        {
          leaseId: "lease-race-1",
          seq: 1,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "good",
          clientReviewedAtMs: T0 + 1_000,
        },
      ],
    });
    expect(expiredResult.ok).toBe(false);
    if (!expiredResult.ok) expect(expiredResult.leaseStatus).toBe("lease_expired");

    // Superseded lease rejected cleanly.
    const nextLease = issueOfflineFlashcardLease({
      leaseId: "lease-race-2",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0 + 10_000,
      candidates: [makeFlashcardCandidate(1)],
      existingActiveLease: minted.lease,
    });
    expect(nextLease.ok).toBe(true);
    if (!nextLease.ok || !nextLease.supersededLease) throw new Error("expected superseded lease");

    const supersededResult = reconcileOfflineLeaseOutbox({
      lease: nextLease.supersededLease,
      serverCards: { "card-1": card1Base },
      serverReceiptAtMs: T0 + 20_000,
      entries: [{ leaseId: "lease-race-1", seq: 1, cardId: "card-1", expectedCardRevision: 1, rating: "good" }],
    });
    expect(supersededResult.ok).toBe(false);
    if (!supersededResult.ok) expect(supersededResult.leaseStatus).toBe("lease_superseded");

    // Revoked lease rejected cleanly.
    const revokedLease = revokeOfflineFlashcardLease(nextLease.lease, T0 + 15_000);
    const revokedResult = reconcileOfflineLeaseOutbox({
      lease: revokedLease,
      serverCards: { "card-1": card1Base },
      serverReceiptAtMs: T0 + 20_000,
      entries: [{ leaseId: "lease-race-2", seq: 1, cardId: "card-1", expectedCardRevision: 1, rating: "good" }],
    });
    expect(revokedResult.ok).toBe(false);
    if (!revokedResult.ok) expect(revokedResult.leaseStatus).toBe("lease_revoked");
  });

  it("rejects non-positive seq values, deduplicates same-batch retries, and computes FSRS elapsed interval strictly from serverReceiptAtMs on reviewed cards", () => {
    const minted = issueOfflineFlashcardLease({
      leaseId: "lease-clock-1",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [makeFlashcardCandidate(1)],
    });
    if (!minted.ok) throw new Error("expected lease");

    // Seed a previously reviewed card (last reviewed 3 days before T0).
    const seedLease = issueOfflineFlashcardLease({
      leaseId: "lease-seed",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0 - 3 * 86_400_000,
      candidates: [{ ...makeFlashcardCandidate(1), cardRevision: 0, lastServerReviewedAtMs: null }],
    });
    if (!seedLease.ok) throw new Error("expected seed lease");
    const seeded = reconcileOfflineLeaseOutbox({
      lease: seedLease.lease,
      serverCards: { "card-1": createInitialOfflineFsrsSnapshot("card-1", T0 - 4 * 86_400_000, 0) },
      serverReceiptAtMs: T0 - 3 * 86_400_000,
      entries: [{ leaseId: "lease-seed", seq: 1, cardId: "card-1", expectedCardRevision: 0, rating: "good" }],
    });
    if (!seeded.ok) throw new Error("expected seeded review");
    const reviewedSnapshot = seeded.updatedServerCards["card-1"]!;
    expect(reviewedSnapshot.revision).toBe(1);
    expect(reviewedSnapshot.reps).toBe(1);

    const receiptAtMs = T0 + 4 * 3_600_000;
    const withForgedClientClock = reconcileOfflineLeaseOutbox({
      lease: minted.lease,
      serverCards: { "card-1": reviewedSnapshot },
      serverReceiptAtMs: receiptAtMs,
      entries: [
        { leaseId: "lease-clock-1", seq: 0, cardId: "card-1", expectedCardRevision: 1, rating: "good" },
        { leaseId: "lease-clock-1", seq: -2, cardId: "card-1", expectedCardRevision: 1, rating: "good" },
        { leaseId: "lease-clock-1", seq: 1.5, cardId: "card-1", expectedCardRevision: 1, rating: "good" },
        {
          leaseId: "lease-clock-1",
          seq: 1,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "good",
          clientReviewedAtMs: T0 + 20 * 86_400_000,
        },
        {
          leaseId: "lease-clock-1",
          seq: 1,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "good",
          clientReviewedAtMs: T0 + 20 * 86_400_000,
        },
      ],
    });
    expect(withForgedClientClock.ok).toBe(true);
    if (!withForgedClientClock.ok) throw new Error("expected reconcile");
    expect(withForgedClientClock.settledCount).toBe(1);
    expect(withForgedClientClock.replayedCount).toBe(1);
    expect(withForgedClientClock.results.filter(r => r.outcome === "invalid_seq")).toHaveLength(3);

    const withHonestClientClock = reconcileOfflineLeaseOutbox({
      lease: minted.lease,
      serverCards: { "card-1": reviewedSnapshot },
      serverReceiptAtMs: receiptAtMs,
      entries: [
        {
          leaseId: "lease-clock-1",
          seq: 1,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "good",
          clientReviewedAtMs: receiptAtMs,
        },
      ],
    });
    expect(withHonestClientClock.ok).toBe(true);
    if (!withHonestClientClock.ok) throw new Error("expected honest reconcile");
    expect(withForgedClientClock.updatedServerCards["card-1"]).toEqual(
      withHonestClientClock.updatedServerCards["card-1"],
    );
    expect(withForgedClientClock.updatedServerCards["card-1"]?.fsrs?.elapsedDays).toBe(3);

    // Shifting serverReceiptAtMs by +5h changes FSRS scheduling (confirming server clock authority).
    const laterServerReceipt = reconcileOfflineLeaseOutbox({
      lease: minted.lease,
      serverCards: { "card-1": reviewedSnapshot },
      serverReceiptAtMs: receiptAtMs + 5 * 3_600_000,
      entries: [
        {
          leaseId: "lease-clock-1",
          seq: 1,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "good",
          clientReviewedAtMs: receiptAtMs,
        },
      ],
    });
    expect(laterServerReceipt.ok).toBe(true);
    if (!laterServerReceipt.ok) throw new Error("expected later reconcile");
    expect(laterServerReceipt.updatedServerCards["card-1"]?.dueAtMs).not.toBe(
      withHonestClientClock.updatedServerCards["card-1"]?.dueAtMs,
    );
  });
});

describe("RFC 8628 90s Companion Scratchpad Pairing & Atomic Freeze (Wave R / Lane R4-B)", () => {
  const PRIMARY_ORIGIN = "https://app.aistudy.example";
  const COMPANION_ORIGIN = "https://companion.aistudy-sandbox.example";
  const DEVICE_CODE = "dev_code_9f8a7b6c5d4e3f2a1b0c";
  const FRAGMENT_SECRET = "ephemeral_frag_secret_77aa88bb99cc";
  const RAW_USER_CODE = "ab23 cd45";

  it("enforces RFC 6265 registrable-site isolation, fragment-only QR secret, ambiguous-char user code rejection, 90s TTL, and authenticated single-use replay revocation", () => {
    expect(COMPANION_PAIRING_TTL_MS).toBe(90_000);
    expect(normalizeOrigin("HTTPS://App.AIStudy.Example:443")).toBe("https://app.aistudy.example");
    expect(normalizeOrigin("http://app.aistudy.example")).toBeNull();
    expect(extractRegistrableSite("https://app.aistudy.example")).toBe("aistudy.example");
    expect(extractRegistrableSite("https://app.aistudy.co.uk")).toBe("aistudy.co.uk");
    expect(extractRegistrableSite("https://portal.uni.edu.cn")).toBe("uni.edu.cn");
    expect(extractRegistrableSite("https://a.gov.ca")).toBe("gov.ca");
    expect(extractRegistrableSite("https://a.co.nz")).toBe("a.co.nz");
    expect(extractRegistrableSite("https://co.nz")).toBeNull();
    expect(extractRegistrableSite("https://co.th")).toBeNull();
    expect(extractRegistrableSite("https://co.uk")).toBeNull();
    expect(extractRegistrableSite("https://127.0.0.1:8443")).toBeNull();
    expect(extractRegistrableSite("https://localhost:3000")).toBeNull();

    // Distinct registrable sites (eTLD+1) are isolated and accepted.
    expect(areCompanionOriginsIsolated(PRIMARY_ORIGIN, COMPANION_ORIGIN)).toBe(true);
    expect(areCompanionOriginsIsolated(PRIMARY_ORIGIN, "https://aistudy-scratchpad.example")).toBe(true);
    expect(
      areCompanionOriginsIsolated("https://app.aistudy.co.uk", "https://companion.aistudy-sandbox.co.uk"),
    ).toBe(true);
    expect(
      areCompanionOriginsIsolated("https://a.uni.edu.cn", "https://companion.other.edu.cn"),
    ).toBe(true);
    expect(
      areCompanionOriginsIsolated("https://a.co.nz", "https://b.co.nz"),
    ).toBe(true);

    // [P1-2 / P1-3] Sibling subdomains, same-host different-port, parent/child suffixes, multi-part
    // public-suffix siblings, `gov.ca` siblings, unverified ccSLD siblings, IP literals, and localhost MUST all be rejected!
    expect(areCompanionOriginsIsolated("https://app.aistudy.example", "https://scratchpad.aistudy.example")).toBe(false);
    expect(areCompanionOriginsIsolated("https://app.aistudy.co.uk", "https://scratchpad.aistudy.co.uk")).toBe(false);
    expect(areCompanionOriginsIsolated("https://a.uni.edu.cn", "https://b.uni.edu.cn")).toBe(false);
    expect(areCompanionOriginsIsolated("https://a.gov.ca", "https://b.gov.ca")).toBe(false);
    expect(areCompanionOriginsIsolated("https://x.a.co.nz", "https://y.a.co.nz")).toBe(false);
    expect(areCompanionOriginsIsolated("https://a.co.th", "https://b.co.th")).toBe(false);
    expect(areCompanionOriginsIsolated("https://app.aistudy.example:443", "https://app.aistudy.example:8443")).toBe(false);
    expect(areCompanionOriginsIsolated("https://aistudy.example", "https://scratchpad.aistudy.example")).toBe(false);
    expect(areCompanionOriginsIsolated("https://app.aistudy.example", "https://sub.app.aistudy.example")).toBe(false);
    expect(areCompanionOriginsIsolated("https://127.0.0.1:3000", "https://127.0.0.1:3001")).toBe(false);
    expect(areCompanionOriginsIsolated("https://10.0.0.1", "https://10.0.0.2")).toBe(false);
    expect(areCompanionOriginsIsolated("https://localhost:3000", "https://companion.localhost:3001")).toBe(false);

    expect(normalizeCompanionUserCode("ab23-cd45")).toBe("AB23-CD45");
    expect(normalizeCompanionUserCode("AB01-CDIL")).toBeNull();
    expect(normalizeCompanionUserCode("ABOO-CD23")).toBeNull();

    const generatedCode = formatCompanionUserCodeFromBytes(new Uint8Array([0, 1, 2, 3, 28, 29, 30, 31]));
    expect(generatedCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

    // Same registrable site (including sibling subdomains, multi-part eTLD+1 siblings, ports,
    // parent/child suffixes, IPs, localhost) and non-HTTPS origins MUST fail closed.
    for (const [primaryOrigin, allowedCompanionOrigin, expectedCode] of [
      ["https://app.aistudy.example:443", "HTTPS://APP.AISTUDY.EXAMPLE", "origin_isolation_violation"],
      ["https://app.aistudy.example:443", "https://app.aistudy.example:8443", "origin_isolation_violation"],
      ["https://app.aistudy.example", "https://scratchpad.aistudy.example", "origin_isolation_violation"],
      ["https://app.aistudy.co.uk", "https://scratchpad.aistudy.co.uk", "origin_isolation_violation"],
      ["https://a.uni.edu.cn", "https://b.uni.edu.cn", "origin_isolation_violation"],
      ["https://aistudy.example", "https://scratchpad.aistudy.example", "origin_isolation_violation"],
      ["https://app.aistudy.example", "https://aistudy.example", "origin_isolation_violation"],
      ["https://app.aistudy.example", "https://sub.app.aistudy.example", "origin_isolation_violation"],
      ["https://127.0.0.1:3000", "https://127.0.0.1:3001", "origin_isolation_violation"],
      ["https://localhost:3000", "https://companion.aistudy-sandbox.example", "origin_isolation_violation"],
      ["http://app.aistudy.example", "http://companion.aistudy-sandbox.example", "invalid_origin"],
    ] as const) {
      const badOrigin = createCompanionPairingOffer({
        offerId: "offer-bad-origin",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        attemptId: "attempt-1",
        primaryOrigin,
        allowedCompanionOrigin,
        issuedAtMs: T0,
        deviceCode: DEVICE_CODE,
        userCode: RAW_USER_CODE,
        fragmentSecret: FRAGMENT_SECRET,
      });
      expect(badOrigin.ok).toBe(false);
      if (!badOrigin.ok) expect(badOrigin.code).toBe(expectedCode);
    }

    const created = createCompanionPairingOffer({
      offerId: "offer-1",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      attemptId: "attempt-1",
      primaryOrigin: PRIMARY_ORIGIN,
      allowedCompanionOrigin: COMPANION_ORIGIN,
      issuedAtMs: T0,
      deviceCode: DEVICE_CODE,
      userCode: RAW_USER_CODE,
      fragmentSecret: FRAGMENT_SECRET,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected offer creation");
    expect(created.expiresAtMs).toBe(T0 + 90_000);
    expect(created.userCode).toBe("AB23-CD45");

    // Verify secret lives strictly in URL fragment (#k=...), NEVER path or query.
    const qrParsedUrl = new URL(created.qrUrl);
    expect(qrParsedUrl.origin).toBe(COMPANION_ORIGIN);
    expect(qrParsedUrl.search).toBe("");
    expect(qrParsedUrl.pathname).not.toContain(FRAGMENT_SECRET);
    expect(qrParsedUrl.hash).toBe(`#k=${encodeURIComponent(FRAGMENT_SECRET)}`);

    const parsedQr = parseCompanionQrUrl(created.qrUrl);
    expect(parsedQr.ok).toBe(true);
    if (!parsedQr.ok) throw new Error("expected QR parse");
    expect(parsedQr.fragmentSecret).toBe(FRAGMENT_SECRET);

    expect(
      parseCompanionQrUrl(`${COMPANION_ORIGIN}/companion/pair?k=${FRAGMENT_SECRET}#k=${FRAGMENT_SECRET}`).ok,
    ).toBe(false);
    // Reject QR URLs containing embedded username/password userinfo credentials.
    expect(
      parseCompanionQrUrl(`https://user:pass@companion.aistudy-sandbox.example/companion/pair#k=${FRAGMENT_SECRET}`).ok,
    ).toBe(false);
    // [P2-1] Reject percent-encoded, hex-encoded, base64url-encoded secret copies in path/query,
    // and fail closed on malformed `%` escape sequences.
    const percentEncodedSecret = `%65${FRAGMENT_SECRET.slice(1)}`;
    const hexEncodedSecret = [...new TextEncoder().encode(FRAGMENT_SECRET)]
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(
      parseCompanionQrUrl(`${COMPANION_ORIGIN}/companion/pair/${percentEncodedSecret}#k=${FRAGMENT_SECRET}`),
    ).toMatchObject({ ok: false, code: "secret_outside_fragment" });
    expect(
      parseCompanionQrUrl(`${COMPANION_ORIGIN}/companion/pair?ref=${percentEncodedSecret}#k=${FRAGMENT_SECRET}`),
    ).toMatchObject({ ok: false, code: "secret_outside_fragment" });
    expect(
      parseCompanionQrUrl(`${COMPANION_ORIGIN}/companion/pair?blob=${hexEncodedSecret}#k=${FRAGMENT_SECRET}`),
    ).toMatchObject({ ok: false, code: "secret_outside_fragment" });
    expect(
      parseCompanionQrUrl(`${COMPANION_ORIGIN}/companion/pair/%E0%A4%A#k=${FRAGMENT_SECRET}`),
    ).toMatchObject({ ok: false, code: "invalid_qr_url" });

    // [Round-5 P1-2] createCompanionPairingOffer MUST validate the assembled QR URL via parseCompanionQrUrl,
    // failing closed when pairingPath carries percent-encoded, hex-encoded, base64url-encoded, or malformed `%` data.
    const base64UrlSecret = btoa(FRAGMENT_SECRET)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    for (const badPath of [
      `/companion/pair/${percentEncodedSecret}`,
      `/companion/pair/${hexEncodedSecret}`,
      `/companion/pair/${base64UrlSecret}`,
      `/companion/pair/%E0%A4%A`,
      `//evil.other-domain.example/companion/pair`,
    ]) {
      const rejectedOffer = createCompanionPairingOffer({
        offerId: "offer-bad-path",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        attemptId: "attempt-1",
        primaryOrigin: PRIMARY_ORIGIN,
        allowedCompanionOrigin: COMPANION_ORIGIN,
        issuedAtMs: T0,
        deviceCode: DEVICE_CODE,
        userCode: RAW_USER_CODE,
        fragmentSecret: FRAGMENT_SECRET,
        pairingPath: badPath,
      });
      expect(rejectedOffer.ok).toBe(false);
      if (!rejectedOffer.ok) expect(rejectedOffer.code).toBe("invalid_pairing_path");
    }

    const proof = deriveCompanionFragmentSecretProof(FRAGMENT_SECRET, DEVICE_CODE);

    // Wrong origin (primary origin trying to redeem) fails closed.
    const wrongOriginRedeem = redeemCompanionPairingOffer({
      offer: created.offer,
      sessionId: "sess-wrong-origin",
      deviceCode: DEVICE_CODE,
      userCode: "ab23cd45",
      fragmentSecretProof: proof,
      requestOrigin: PRIMARY_ORIGIN,
      nowMs: T0 + 10_000,
    });
    expect(wrongOriginRedeem.ok).toBe(false);
    if (!wrongOriginRedeem.ok) expect(wrongOriginRedeem.code).toBe("origin_mismatch");

    // Expired at +90_001ms fails closed.
    const expiredRedeem = redeemCompanionPairingOffer({
      offer: created.offer,
      sessionId: "sess-expired",
      deviceCode: DEVICE_CODE,
      userCode: "ab23cd45",
      fragmentSecretProof: proof,
      requestOrigin: COMPANION_ORIGIN,
      nowMs: T0 + 90_001,
    });
    expect(expiredRedeem.ok).toBe(false);
    if (!expiredRedeem.ok) {
      expect(expiredRedeem.code).toBe("pairing_expired");
      expect(expiredRedeem.offer.status).toBe("expired");
    }

    // Valid redemption right at the 90s boundary succeeds with strict cookie policy.
    const redeemed = redeemCompanionPairingOffer({
      offer: created.offer,
      sessionId: "sess-1",
      deviceCode: DEVICE_CODE,
      userCode: "ab23cd45",
      fragmentSecretProof: proof,
      requestOrigin: COMPANION_ORIGIN,
      nowMs: T0 + 90_000,
    });
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) throw new Error("expected redemption");
    expect(redeemed.offer.status).toBe("redeemed");
    expect(redeemed.session.scopedAttemptId).toBe("attempt-1");
    expect(redeemed.session.allowedActions).toEqual(COMPANION_ALLOWED_ACTIONS);
    expect(redeemed.session.cookieAttributes).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/api/companion/scratchpad",
    });

    // [P1-4] Unauthenticated probes against an already-redeemed offer MUST return 403
    // WITHOUT triggering session revocation (prevents unauthenticated DoS revocation).
    for (const probe of [
      {
        deviceCode: DEVICE_CODE,
        userCode: "ZZZZ-ZZZZ",
        fragmentSecretProof: proof,
        requestOrigin: COMPANION_ORIGIN,
        expectedCode: "invalid_pairing_credentials",
      },
      {
        deviceCode: DEVICE_CODE,
        userCode: "AB23-CD45",
        fragmentSecretProof: "0".repeat(64),
        requestOrigin: COMPANION_ORIGIN,
        expectedCode: "invalid_pairing_credentials",
      },
      {
        deviceCode: DEVICE_CODE,
        userCode: "AB23-CD45",
        fragmentSecretProof: proof,
        requestOrigin: PRIMARY_ORIGIN,
        expectedCode: "origin_mismatch",
      },
    ] as const) {
      const unauthProbe = redeemCompanionPairingOffer({
        offer: redeemed.offer,
        sessionId: "sess-unauth-probe",
        deviceCode: probe.deviceCode,
        userCode: probe.userCode,
        fragmentSecretProof: probe.fragmentSecretProof,
        requestOrigin: probe.requestOrigin,
        nowMs: T0 + 90_000,
      });
      expect(unauthProbe.ok).toBe(false);
      if (!unauthProbe.ok) {
        expect(unauthProbe.httpStatus).toBe(403);
        expect(unauthProbe.code).toBe(probe.expectedCode);
        expect(unauthProbe.revokeIssuedSession).toBe(false);
        expect(unauthProbe.revokedSessionId).toBeNull();
        expect(unauthProbe.offer.replayDetectedAtMs).toBeNull();
      }
    }

    // Authenticated second redemption attempt with valid credentials MUST signal immediate revocation!
    const replay = redeemCompanionPairingOffer({
      offer: redeemed.offer,
      sessionId: "sess-replay",
      deviceCode: DEVICE_CODE,
      userCode: "AB23-CD45",
      fragmentSecretProof: proof,
      requestOrigin: COMPANION_ORIGIN,
      nowMs: T0 + 90_000,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.httpStatus).toBe(409);
      expect(replay.code).toBe("pairing_already_redeemed");
      expect(replay.revokeIssuedSession).toBe(true);
      expect(replay.revokedSessionId).toBe("sess-1");
    }
  });

  it("enforces the hard capability firewall and atomic draftRevision freeze against tablet upload races", () => {
    const created = createCompanionPairingOffer({
      offerId: "offer-fw",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      attemptId: "attempt-42",
      primaryOrigin: PRIMARY_ORIGIN,
      allowedCompanionOrigin: COMPANION_ORIGIN,
      issuedAtMs: T0,
      deviceCode: DEVICE_CODE,
      userCode: "EF67-GH89",
      fragmentSecret: FRAGMENT_SECRET,
    });
    if (!created.ok) throw new Error("expected offer");

    const redeemed = redeemCompanionPairingOffer({
      offer: created.offer,
      sessionId: "sess-fw",
      deviceCode: DEVICE_CODE,
      userCode: "ef67gh89",
      fragmentSecretProof: deriveCompanionFragmentSecretProof(FRAGMENT_SECRET, DEVICE_CODE),
      requestOrigin: COMPANION_ORIGIN,
      nowMs: T0 + 5_000,
    });
    if (!redeemed.ok) throw new Error("expected session");
    const session = redeemed.session;

    // Allowed actions pass on bound attempt.
    for (const action of COMPANION_ALLOWED_ACTIONS) {
      const auth = authorizeCompanionAction({
        session,
        action,
        attemptId: "attempt-42",
        requestOrigin: COMPANION_ORIGIN,
        nowMs: T0 + 10_000,
      });
      expect(auth.allowed).toBe(true);
    }

    // Forbidden actions deterministically rejected with 403 companion_capability_forbidden.
    for (const forbidden of [...COMPANION_FORBIDDEN_ACTIONS, "export_workspace"]) {
      const auth = authorizeCompanionAction({
        session,
        action: forbidden,
        attemptId: "attempt-42",
        requestOrigin: COMPANION_ORIGIN,
        nowMs: T0 + 10_000,
      });
      expect(auth).toMatchObject({
        allowed: false,
        httpStatus: 403,
        reason: "companion_capability_forbidden",
      });
    }

    // Even a tampered session claiming submit_attempt in allowedActions MUST be rejected.
    const tamperedSession = {
      ...session,
      allowedActions: ["upload_page", "submit_attempt"] as unknown as typeof session.allowedActions,
    };
    expect(
      authorizeCompanionAction({
        session: tamperedSession,
        action: "submit_attempt",
        attemptId: "attempt-42",
        requestOrigin: COMPANION_ORIGIN,
        nowMs: T0 + 10_000,
      }),
    ).toMatchObject({
      allowed: false,
      httpStatus: 403,
      reason: "companion_capability_forbidden",
    });

    // Mandatory requestOrigin check on authorizeCompanionAction (missing or wrong origin fails closed).
    expect(
      authorizeCompanionAction({
        session,
        action: "upload_page",
        attemptId: "attempt-42",
        requestOrigin: PRIMARY_ORIGIN,
        nowMs: T0 + 10_000,
      }),
    ).toMatchObject({
      allowed: false,
      httpStatus: 403,
      reason: "companion_capability_forbidden",
    });
    expect(
      authorizeCompanionAction({
        session,
        action: "upload_page",
        attemptId: "attempt-42",
        requestOrigin: "",
        nowMs: T0 + 10_000,
      }),
    ).toMatchObject({
      allowed: false,
      httpStatus: 403,
      reason: "companion_capability_forbidden",
    });

    // Cross-attempt access rejected with 403 attempt_mismatch.
    expect(
      authorizeCompanionAction({
        session,
        action: "upload_page",
        attemptId: "attempt-999",
        requestOrigin: COMPANION_ORIGIN,
        nowMs: T0 + 10_000,
      }),
    ).toMatchObject({ allowed: false, httpStatus: 403, reason: "attempt_mismatch" });

    // Expired & revoked sessions rejected cleanly.
    expect(
      authorizeCompanionAction({
        session,
        action: "heartbeat",
        attemptId: "attempt-42",
        requestOrigin: COMPANION_ORIGIN,
        nowMs: session.expiresAtMs + 1,
      }),
    ).toMatchObject({ allowed: false, httpStatus: 403, reason: "session_expired" });

    const revokedSession = revokeCompanionSession(session, T0 + 15_000, "pairing_replay_detected");
    expect(
      authorizeCompanionAction({
        session: revokedSession,
        action: "upload_page",
        attemptId: "attempt-42",
        requestOrigin: COMPANION_ORIGIN,
        nowMs: T0 + 16_000,
      }),
    ).toMatchObject({ allowed: false, httpStatus: 403, reason: "session_revoked" });

    // Atomic scratchpad draft revisions and freeze race.
    const shaA = "a".repeat(64);
    const shaB = "b".repeat(64);
    const shaC = "c".repeat(64);
    const draft0 = createCompanionScratchpadDraft({
      workspaceId: "ws-1",
      learnerId: "learner-1",
      attemptId: "attempt-42",
    });
    expect(draft0.draftRevision).toBe(0);

    // [P1-5] Mandatory session + requestOrigin + nowMs authorization on appendCompanionScratchpadPage.
    expect(ALLOWED_SCRATCHPAD_MIME_TYPES).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "application/pdf",
    ]);
    expect(MAX_SCRATCHPAD_PAGE_BYTES).toBe(15 * 1024 * 1024);

    const missingSessionUpload = appendCompanionScratchpadPage(draft0, {
      session: undefined as unknown as typeof session,
      requestOrigin: COMPANION_ORIGIN,
      nowMs: T0 + 18_000,
      pageNumber: 1,
      objectKey: "scratchpad/attempt-42/p1.png",
      sha256: shaA,
      mimeType: "image/png",
      byteLength: 42_000,
    });
    expect(missingSessionUpload).toMatchObject({
      ok: false,
      code: "companion_capability_forbidden",
      httpStatus: 403,
    });
    expect(missingSessionUpload.state.draftRevision).toBe(0);

    const wrongOriginUpload = appendCompanionScratchpadPage(draft0, {
      session,
      requestOrigin: PRIMARY_ORIGIN,
      nowMs: T0 + 18_500,
      pageNumber: 1,
      objectKey: "scratchpad/attempt-42/p1.png",
      sha256: shaA,
      mimeType: "image/png",
      byteLength: 42_000,
    });
    expect(wrongOriginUpload).toMatchObject({
      ok: false,
      code: "companion_capability_forbidden",
      httpStatus: 403,
    });

    const revokedUpload = appendCompanionScratchpadPage(draft0, {
      session: revokedSession,
      requestOrigin: COMPANION_ORIGIN,
      nowMs: T0 + 19_000,
      pageNumber: 1,
      objectKey: "scratchpad/attempt-42/p1.png",
      sha256: shaA,
      mimeType: "image/png",
      byteLength: 42_000,
    });
    expect(revokedUpload).toMatchObject({
      ok: false,
      code: "session_revoked",
      httpStatus: 403,
    });

    // [P2-2] Reject disallowed MIME types, parameterized MIME types, and oversized byteLength.
    for (const invalidUpload of [
      { mimeType: "image/svg+xml", byteLength: 1024 },
      { mimeType: "text/html", byteLength: 1024 },
      { mimeType: "image/png; charset=utf-8", byteLength: 1024 },
      { mimeType: "image/png", byteLength: MAX_SCRATCHPAD_PAGE_BYTES + 1 },
      { mimeType: "image/png", byteLength: 0 },
    ]) {
      const badPage = appendCompanionScratchpadPage(draft0, {
        session,
        requestOrigin: COMPANION_ORIGIN,
        nowMs: T0 + 19_500,
        pageNumber: 1,
        objectKey: "scratchpad/attempt-42/p1.png",
        sha256: shaA,
        mimeType: invalidUpload.mimeType,
        byteLength: invalidUpload.byteLength,
      });
      expect(badPage).toMatchObject({
        ok: false,
        code: "invalid_page_payload",
        httpStatus: 400,
      });
    }

    const up1 = appendCompanionScratchpadPage(draft0, {
      session,
      requestOrigin: COMPANION_ORIGIN,
      nowMs: T0 + 20_000,
      pageNumber: 1,
      objectKey: "scratchpad/attempt-42/p1.png",
      sha256: shaA,
      mimeType: "IMAGE/PNG",
      byteLength: 42_000,
    });
    expect(up1.ok).toBe(true);
    if (!up1.ok) throw new Error("expected page 1");
    expect(up1.draftRevision).toBe(1);
    expect(up1.page.mimeType).toBe("image/png");

    // Tablet races page 2 before desktop clicks submit using stale preview revision 1.
    const up2 = appendCompanionScratchpadPage(up1.state, {
      session,
      requestOrigin: COMPANION_ORIGIN,
      nowMs: T0 + 25_000,
      pageNumber: 2,
      objectKey: "scratchpad/attempt-42/p2.pdf",
      sha256: shaB,
      mimeType: "application/pdf",
      byteLength: 55_000,
    });
    expect(up2.ok).toBe(true);
    if (!up2.ok) throw new Error("expected page 2");
    expect(up2.draftRevision).toBe(2);

    const staleFreeze = freezeCompanionScratchpadForSubmit(up2.state, {
      expectedDraftRevision: 1,
      frozenAtMs: T0 + 30_000,
    });
    expect(staleFreeze).toMatchObject({
      ok: false,
      code: "draft_changed",
      httpStatus: 409,
      currentDraftRevision: 2,
    });
    expect(staleFreeze.state.frozen).toBe(false);

    // Desktop refreshes preview to revision 2 and freezes atomically.
    const frozen = freezeCompanionScratchpadForSubmit(up2.state, {
      expectedDraftRevision: 2,
      frozenAtMs: T0 + 35_000,
    });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) throw new Error("expected freeze");
    expect(frozen.frozen).toBe(true);
    expect(frozen.frozenAtMs).toBe(T0 + 35_000);
    expect(frozen.frozenRevision).toBe(2);
    expect(frozen.frozenPages).toHaveLength(2);

    // Post-freeze upload MUST fail closed with 409 scratchpad_already_frozen.
    const postFreezeUpload = appendCompanionScratchpadPage(frozen.state, {
      session,
      requestOrigin: COMPANION_ORIGIN,
      nowMs: T0 + 40_000,
      pageNumber: 3,
      objectKey: "scratchpad/attempt-42/p3.webp",
      sha256: shaC,
      mimeType: "image/webp",
      byteLength: 10_000,
    });
    expect(postFreezeUpload).toMatchObject({
      ok: false,
      code: "scratchpad_already_frozen",
      httpStatus: 409,
    });
  });
});

describe("1-Hop Bounded Cross-Course Concept Bridge (Wave R / Lane R4-C)", () => {
  it("enforces strict 1-hop propagation only (ignores A->B upstream and bridge-only B->C)", () => {
    expect(BASE_PRIOR_ALPHA).toBe(1);
    expect(BASE_PRIOR_BETA).toBe(1);
    expect(MAX_BRIDGE_WEIGHT).toBe(0.3);
    expect(MAX_BRIDGE_PSEUDO_OBSERVATIONS).toBe(0.3);
    expect(MIN_DIRECT_OBSERVATIONS_FOR_BRIDGE).toBe(3);
    expect(MAX_BRIDGE_PRIOR_MEAN).toBeCloseTo(1.3 / 2.3, 12);
    expect(MIN_BRIDGE_PRIOR_MEAN).toBeCloseTo(1 / 2.3, 12);

    // Graph A -> B (strong direct mastery) and B -> C (0 direct obs, bridged only):
    // Computing for C must yield exact Beta(1, 1) with zero multi-hop leakage!
    const zeroPropagation = computeCrossCourseWeakPrior({
      targetCourseId: "course-c",
      targetConceptId: "eigenvalues",
      edges: [
        {
          edgeId: "a-to-b",
          sourceCourseId: "course-a",
          sourceConceptId: "linear-maps",
          targetCourseId: "course-b",
          targetConceptId: "matrices",
          alignmentWeight: 1,
          sourceDirectSuccessCount: 25,
          sourceDirectObservationCount: 25,
          edgePrivacyEpoch: 1,
          supportingSourceIds: ["src-a1"],
        },
        {
          edgeId: "b-to-c-bridged-only",
          sourceCourseId: "course-b",
          sourceConceptId: "matrices",
          targetCourseId: "course-c",
          targetConceptId: "eigenvalues",
          alignmentWeight: 1,
          sourceMasteryProbability: 0.95,
          sourceDirectObservationCount: 0,
          edgePrivacyEpoch: 1,
          supportingSourceIds: ["src-b1"],
        },
      ],
      coursePrivacyEpochs: { "course-a": 1, "course-b": 1 },
      activeCourseSharingEnabled: { "course-a": true, "course-b": true },
      revokedSourceIds: new Set<string>(),
    });

    expect(zeroPropagation.alpha).toBe(1);
    expect(zeroPropagation.beta).toBe(1);
    expect(zeroPropagation.posteriorMean).toBe(0.5);
    expect(zeroPropagation.acceptedEdges).toHaveLength(0);
    expect(zeroPropagation.ignoredNonDirectEdges).toHaveLength(1);
    expect(zeroPropagation.ignoredNonDirectEdges[0]?.edgeId).toBe("a-to-b");
    expect(zeroPropagation.decoupledEdges).toHaveLength(1);
    expect(zeroPropagation.decoupledEdges[0]?.reason).toBe("no_direct_source_observations");
    expect(zeroPropagation.isWeakPriorOnly).toBe(true);
    expect(zeroPropagation.requiresInCourseVerification).toBe(true);
  });

  it("caps aggregated pseudo-observations at <= 0.30 (posteriorMean strictly within [1/2.3, 1.3/2.3]) and decouples <3 or non-integer direct observations", () => {
    const manyStrongEdges = Array.from({ length: 20 }, (_, i) => ({
      edgeId: `strong-${i}`,
      sourceCourseId: `course-${i}`,
      sourceConceptId: `concept-${i}`,
      targetCourseId: "course-target",
      targetConceptId: "target-concept",
      alignmentWeight: 1,
      sourceDirectSuccessCount: 15,
      sourceDirectObservationCount: 15,
      edgePrivacyEpoch: 2,
      supportingSourceIds: [`src-${i}`],
    }));

    const epochs = Object.fromEntries(manyStrongEdges.map(e => [e.sourceCourseId, 2]));
    const sharing = Object.fromEntries(manyStrongEdges.map(e => [e.sourceCourseId, true]));

    const upperBound = computeCrossCourseWeakPrior({
      targetCourseId: "course-target",
      targetConceptId: "target-concept",
      edges: manyStrongEdges,
      coursePrivacyEpochs: epochs,
      activeCourseSharingEnabled: sharing,
      revokedSourceIds: new Set<string>(),
    });
    expect(upperBound.equivalentObservations).toBeCloseTo(0.3, 12);
    expect(upperBound.deltaAlpha + upperBound.deltaBeta).toBeLessThanOrEqual(0.3 + 1e-12);
    expect(upperBound.alpha).toBeCloseTo(1.3, 12);
    expect(upperBound.beta).toBeCloseTo(1, 12);
    expect(upperBound.posteriorMean).toBeCloseTo(MAX_BRIDGE_PRIOR_MEAN, 12);
    expect(upperBound.posteriorMean).toBeLessThanOrEqual(0.5 + 0.15);

    const manyWeakEdges = manyStrongEdges.map(e => ({ ...e, sourceDirectSuccessCount: 0 }));
    const lowerBound = computeCrossCourseWeakPrior({
      targetCourseId: "course-target",
      targetConceptId: "target-concept",
      edges: manyWeakEdges,
      coursePrivacyEpochs: epochs,
      activeCourseSharingEnabled: sharing,
      revokedSourceIds: new Set<string>(),
    });
    expect(lowerBound.equivalentObservations).toBeCloseTo(0.3, 12);
    expect(lowerBound.posteriorMean).toBeCloseTo(MIN_BRIDGE_PRIOR_MEAN, 12);
    expect(lowerBound.posteriorMean).toBeGreaterThanOrEqual(0.5 - 0.15);

    // [P1-1] Direct observation counts of 1, 2, non-integer counts, or uncertified probability counts < 3 MUST decouple!
    const insufficient = computeCrossCourseWeakPrior({
      targetCourseId: "course-target",
      targetConceptId: "target-concept",
      edges: [
        {
          edgeId: "only-1-obs",
          sourceCourseId: "course-1",
          sourceConceptId: "c1",
          targetCourseId: "course-target",
          targetConceptId: "target-concept",
          alignmentWeight: 0.3,
          sourceDirectSuccessCount: 1,
          sourceDirectObservationCount: 1,
          edgePrivacyEpoch: 1,
          supportingSourceIds: [],
        },
        {
          edgeId: "only-2-obs",
          sourceCourseId: "course-2",
          sourceConceptId: "c2",
          targetCourseId: "course-target",
          targetConceptId: "target-concept",
          alignmentWeight: 0.3,
          sourceDirectSuccessCount: 2,
          sourceDirectObservationCount: 2,
          edgePrivacyEpoch: 1,
          supportingSourceIds: [],
        },
        {
          edgeId: "fractional-obs",
          sourceCourseId: "course-3",
          sourceConceptId: "c3",
          targetCourseId: "course-target",
          targetConceptId: "target-concept",
          alignmentWeight: 0.3,
          sourceDirectSuccessCount: 3,
          sourceDirectObservationCount: 3.5,
          edgePrivacyEpoch: 1,
          supportingSourceIds: [],
        },
        {
          edgeId: "fractional-success",
          sourceCourseId: "course-4",
          sourceConceptId: "c4",
          targetCourseId: "course-target",
          targetConceptId: "target-concept",
          alignmentWeight: 0.3,
          sourceDirectSuccessCount: 1.5,
          sourceDirectObservationCount: 4,
          edgePrivacyEpoch: 1,
          supportingSourceIds: [],
        },
        {
          edgeId: "missing-certified-count",
          sourceCourseId: "course-5",
          sourceConceptId: "c5",
          targetCourseId: "course-target",
          targetConceptId: "target-concept",
          alignmentWeight: 0.3,
          sourceDirectOnlyMasteryProbability: 0.9,
          sourceDirectObservationCount: 5,
          edgePrivacyEpoch: 1,
          supportingSourceIds: [],
        },
        {
          edgeId: "certified-count-too-small",
          sourceCourseId: "course-6",
          sourceConceptId: "c6",
          targetCourseId: "course-target",
          targetConceptId: "target-concept",
          alignmentWeight: 0.3,
          sourceDirectOnlyMasteryProbability: 0.9,
          certifiedDirectObservationCount: 2,
          sourceDirectObservationCount: 5,
          edgePrivacyEpoch: 1,
          supportingSourceIds: [],
        },
      ],
      coursePrivacyEpochs: {
        "course-1": 1,
        "course-2": 1,
        "course-3": 1,
        "course-4": 1,
        "course-5": 1,
        "course-6": 1,
      },
      activeCourseSharingEnabled: {
        "course-1": true,
        "course-2": true,
        "course-3": true,
        "course-4": true,
        "course-5": true,
        "course-6": true,
      },
      revokedSourceIds: new Set<string>(),
    });
    expect(insufficient.acceptedEdges).toHaveLength(0);
    expect(insufficient.posteriorMean).toBe(0.5);
    expect(insufficient.decoupledEdges).toEqual([
      expect.objectContaining({ edgeId: "only-1-obs", reason: "insufficient_direct_evidence" }),
      expect.objectContaining({ edgeId: "only-2-obs", reason: "insufficient_direct_evidence" }),
      expect.objectContaining({ edgeId: "fractional-obs", reason: "insufficient_direct_evidence" }),
      expect.objectContaining({ edgeId: "fractional-success", reason: "invalid_edge_parameters" }),
      expect.objectContaining({ edgeId: "missing-certified-count", reason: "insufficient_direct_evidence" }),
      expect.objectContaining({ edgeId: "certified-count-too-small", reason: "insufficient_direct_evidence" }),
    ]);
  });

  it("performs instant read-time privacy_epoch / sharing / source revocation decoupling and preserves targetInCourseState bit-for-bit", () => {
    const targetInCourseState = Object.freeze({
      courseId: "course-target",
      directAttempts: 4,
      directMasteryBand: "usable" as const,
      verifiedEvidenceIds: Object.freeze(["ev-1", "ev-2"]),
    });

    const edges = [
      {
        edgeId: "edge-epoch-drift",
        sourceCourseId: "course-a",
        sourceConceptId: "vectors",
        targetCourseId: "course-target",
        targetConceptId: "span",
        alignmentWeight: 0.9,
        sourceDirectOnlyMasteryProbability: 0.95,
        certifiedDirectObservationCount: 8,
        sourceDirectObservationCount: 8,
        edgePrivacyEpoch: 3,
        supportingSourceIds: ["src-a1"],
      },
      {
        edgeId: "edge-sharing-off",
        sourceCourseId: "course-b",
        sourceConceptId: "basis",
        targetCourseId: "course-target",
        targetConceptId: "span",
        alignmentWeight: 0.8,
        sourceDirectSuccessCount: 5,
        sourceDirectObservationCount: 6,
        edgePrivacyEpoch: 5,
        supportingSourceIds: ["src-b1"],
      },
      {
        edgeId: "edge-source-revoked",
        sourceCourseId: "course-c",
        sourceConceptId: "rank",
        targetCourseId: "course-target",
        targetConceptId: "span",
        alignmentWeight: 0.7,
        sourceDirectOnlyMasteryProbability: 0.85,
        certifiedDirectObservationCount: 5,
        sourceDirectObservationCount: 5,
        edgePrivacyEpoch: 2,
        supportingSourceIds: ["src-c1", "src-c2-revoked"],
      },
    ];

    // Before revocation: all 3 active -> posteriorMean boosted above 0.5 and <= MAX_BRIDGE_PRIOR_MEAN.
    const activePrior = computeCrossCourseWeakPrior({
      targetCourseId: "course-target",
      targetConceptId: "span",
      edges,
      coursePrivacyEpochs: { "course-a": 3, "course-b": 5, "course-c": 2 },
      activeCourseSharingEnabled: { "course-a": true, "course-b": true, "course-c": true },
      revokedSourceIds: new Set<string>(),
      targetInCourseState,
    });
    expect(activePrior.acceptedEdges).toHaveLength(3);
    expect(activePrior.equivalentObservations).toBeCloseTo(0.3, 12);
    expect(activePrior.posteriorMean).toBeGreaterThan(0.5);
    expect(activePrior.posteriorMean).toBeLessThanOrEqual(MAX_BRIDGE_PRIOR_MEAN);

    // After instant read-time revocation across all 3 mechanisms:
    // - course-a privacy_epoch bumped 3 -> 4
    // - course-b sharing turned off
    // - src-c2-revoked added to revokedSourceIds
    const revokedPrior = computeCrossCourseWeakPrior({
      targetCourseId: "course-target",
      targetConceptId: "span",
      edges,
      coursePrivacyEpochs: { "course-a": 4, "course-b": 5, "course-c": 2 },
      activeCourseSharingEnabled: { "course-a": true, "course-b": false, "course-c": true },
      revokedSourceIds: new Set<string>(["src-c2-revoked"]),
      targetInCourseState,
    });

    expect(revokedPrior.alpha).toBe(1);
    expect(revokedPrior.beta).toBe(1);
    expect(revokedPrior.deltaAlpha).toBe(0);
    expect(revokedPrior.deltaBeta).toBe(0);
    expect(revokedPrior.equivalentObservations).toBe(0);
    expect(revokedPrior.posteriorMean).toBe(0.5);
    expect(revokedPrior.acceptedEdges).toHaveLength(0);
    expect(revokedPrior.decoupledEdges).toEqual([
      expect.objectContaining({ edgeId: "edge-epoch-drift", reason: "privacy_epoch_mismatch" }),
      expect.objectContaining({ edgeId: "edge-sharing-off", reason: "course_sharing_disabled" }),
      expect.objectContaining({ edgeId: "edge-source-revoked", reason: "supporting_source_revoked" }),
    ]);
    // Target in-course state is preserved bit-for-bit untouched.
    expect(revokedPrior.targetInCourseState).toBe(targetInCourseState);
    expect(revokedPrior.targetInCourseState).toEqual({
      courseId: "course-target",
      directAttempts: 4,
      directMasteryBand: "usable",
      verifiedEvidenceIds: ["ev-1", "ev-2"],
    });
  });

  it("rejects same-course, multi-hop flagged, missing-epoch, bridged-prior contamination ([P1-6]), and duplicate-edge weight inflation", async () => {
    const result = computeCrossCourseWeakPrior({
      targetCourseId: "course-target",
      targetConceptId: "span",
      edges: [
        {
          edgeId: "same-course",
          sourceCourseId: "course-target",
          sourceConceptId: "vectors",
          targetCourseId: "course-target",
          targetConceptId: "span",
          alignmentWeight: 0.3,
          sourceDirectOnlyMasteryProbability: 1,
          certifiedDirectObservationCount: 10,
          sourceDirectObservationCount: 10,
          edgePrivacyEpoch: 1,
          supportingSourceIds: [],
        },
        {
          edgeId: "same-course-padded",
          sourceCourseId: "  course-target  ",
          sourceConceptId: "vectors-2",
          targetCourseId: "course-target",
          targetConceptId: "span",
          alignmentWeight: 0.3,
          sourceDirectOnlyMasteryProbability: 1,
          certifiedDirectObservationCount: 10,
          sourceDirectObservationCount: 10,
          edgePrivacyEpoch: 1,
          supportingSourceIds: [],
        },
        {
          edgeId: "multi-hop-flagged",
          sourceCourseId: "course-a",
          sourceConceptId: "hop2",
          targetCourseId: "course-target",
          targetConceptId: "span",
          alignmentWeight: 0.3,
          sourceDirectOnlyMasteryProbability: 1,
          certifiedDirectObservationCount: 10,
          sourceDirectObservationCount: 10,
          edgePrivacyEpoch: 1,
          supportingSourceIds: [],
          hopCount: 2,
        },
        {
          edgeId: "missing-epoch",
          sourceCourseId: "course-unknown",
          sourceConceptId: "c1",
          targetCourseId: "course-target",
          targetConceptId: "span",
          alignmentWeight: 0.3,
          sourceDirectOnlyMasteryProbability: 1,
          certifiedDirectObservationCount: 10,
          sourceDirectObservationCount: 10,
          edgePrivacyEpoch: 1,
          supportingSourceIds: [],
        },
        // [P1-6] Uncertified mixed `sourceMasteryProbability` (no direct counts / direct-only probability) MUST decouple.
        {
          edgeId: "mixed-only-edge",
          sourceCourseId: "course-mixed",
          sourceConceptId: "relayed-from-a",
          targetCourseId: "course-target",
          targetConceptId: "span",
          alignmentWeight: 0.3,
          sourceMasteryProbability: 0.95,
          sourceDirectObservationCount: 4,
          edgePrivacyEpoch: 1,
          supportingSourceIds: [],
        },
        // [P1-6] `includesBridgedPrior: true` without raw direct counts MUST decouple.
        {
          edgeId: "contaminated-edge",
          sourceCourseId: "course-contaminated",
          sourceConceptId: "mixed-prior",
          targetCourseId: "course-target",
          targetConceptId: "span",
          alignmentWeight: 0.3,
          sourceDirectOnlyMasteryProbability: 0.9,
          certifiedDirectObservationCount: 4,
          includesBridgedPrior: true,
          sourceDirectObservationCount: 4,
          edgePrivacyEpoch: 1,
          supportingSourceIds: [],
        },
        // Duplicate identical (sourceCourseId, sourceConceptId) edge with weight 0.2 must NOT inflate to 0.3 or 0.4.
        {
          edgeId: "valid-dup-1",
          sourceCourseId: "course-valid",
          sourceConceptId: "linear-comb",
          targetCourseId: "course-target",
          targetConceptId: "span",
          alignmentWeight: 0.2,
          sourceDirectOnlyMasteryProbability: 0.9,
          certifiedDirectObservationCount: 4,
          sourceDirectObservationCount: 4,
          edgePrivacyEpoch: 7,
          supportingSourceIds: ["src-v1"],
        },
        {
          edgeId: "valid-dup-2",
          sourceCourseId: "course-valid",
          sourceConceptId: "linear-comb",
          targetCourseId: "course-target",
          targetConceptId: "span",
          alignmentWeight: 0.2,
          sourceDirectOnlyMasteryProbability: 0.9,
          certifiedDirectObservationCount: 4,
          sourceDirectObservationCount: 4,
          edgePrivacyEpoch: 7,
          supportingSourceIds: ["src-v1"],
        },
      ],
      coursePrivacyEpochs: {
        "course-a": 1,
        "course-target": 1,
        "course-mixed": 1,
        "course-contaminated": 1,
        "course-valid": 7,
      },
      activeCourseSharingEnabled: {
        "course-a": true,
        "course-target": true,
        "course-unknown": true,
        "course-mixed": true,
        "course-contaminated": true,
        "course-valid": true,
      },
      revokedSourceIds: new Set<string>(),
    });

    expect(result.ignoredNonDirectEdges).toEqual([
      expect.objectContaining({ edgeId: "same-course", reason: "same_course_edge" }),
      expect.objectContaining({ edgeId: "same-course-padded", reason: "same_course_edge" }),
    ]);
    expect(result.decoupledEdges).toEqual([
      expect.objectContaining({ edgeId: "multi-hop-flagged", reason: "multi_hop_rejected" }),
      expect.objectContaining({ edgeId: "missing-epoch", reason: "privacy_epoch_mismatch" }),
      expect.objectContaining({ edgeId: "mixed-only-edge", reason: "bridged_prior_contamination" }),
      expect.objectContaining({ edgeId: "contaminated-edge", reason: "bridged_prior_contamination" }),
    ]);
    expect(result.acceptedEdges).toHaveLength(1);
    expect(result.equivalentObservations).toBeCloseTo(0.2, 12);
    expect(result.deltaAlpha).toBeCloseTo(0.18, 12);
    expect(result.deltaBeta).toBeCloseTo(0.02, 12);
    expect(result.posteriorMean).toBeCloseTo(1.18 / 2.2, 12);

    // [P1-6] When raw direct counts are supplied alongside a higher mixed `sourceMasteryProbability`
    // inflated by an upstream course A, ONLY `sourceDirectSuccessCount / sourceDirectObservationCount`
    // is used and bounded at <= 0.30!
    const directCountOnly = computeCrossCourseWeakPrior({
      targetCourseId: "course-c",
      targetConceptId: "eigenvalues",
      edges: [
        {
          edgeId: "b-to-c-with-direct-counts",
          sourceCourseId: "course-b",
          sourceConceptId: "matrices",
          targetCourseId: "course-c",
          targetConceptId: "eigenvalues",
          alignmentWeight: 1,
          sourceDirectSuccessCount: 1,
          sourceDirectObservationCount: 4, // pure direct ratio = 0.25
          sourceMasteryProbability: 0.99, // mixed posterior polluted by Course A — MUST be ignored!
          includesBridgedPrior: true,
          edgePrivacyEpoch: 1,
          supportingSourceIds: ["src-b1"],
        },
      ],
      coursePrivacyEpochs: { "course-b": 1 },
      activeCourseSharingEnabled: { "course-b": true },
      revokedSourceIds: new Set<string>(),
    });
    expect(directCountOnly.acceptedEdges).toHaveLength(1);
    expect(directCountOnly.acceptedEdges[0]?.directEvidenceSource).toBe("direct_counts");
    expect(directCountOnly.acceptedEdges[0]?.sourceDirectOnlyMasteryProbability).toBe(0.25);
    expect(directCountOnly.equivalentObservations).toBeCloseTo(0.3, 12);
    expect(directCountOnly.deltaAlpha).toBeCloseTo(0.075, 12);
    expect(directCountOnly.deltaBeta).toBeCloseTo(0.225, 12);
    expect(directCountOnly.posteriorMean).toBeCloseTo(1.075 / 2.3, 12);

    // [Round-7 P1-3] Mixed-case UUID revocation & course identity normalization:
    // Uppercase UUID in supportingSourceIds MUST be decoupled by lowercase UUID in revokedSourceIds!
    const upperUuid = "550E8400-E29B-41D4-A716-446655440000";
    const lowerUuid = "550e8400-e29b-41d4-a716-446655440000";
    const courseAUuidUpper = "11111111-2222-4333-8444-555555555555".toUpperCase();
    const courseAUuidLower = "11111111-2222-4333-8444-555555555555";
    const targetCourseUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    expect(canonicalizeIdentifier(upperUuid)).toBe(lowerUuid);

    const mixedCaseRevoked = computeCrossCourseWeakPrior({
      targetCourseId: targetCourseUuid,
      targetConceptId: "eigenvalues",
      edges: [
        {
          edgeId: "mixed-case-revoked-edge",
          sourceCourseId: courseAUuidUpper,
          sourceConceptId: "matrices",
          targetCourseId: targetCourseUuid.toUpperCase(),
          targetConceptId: "eigenvalues",
          alignmentWeight: 0.3,
          sourceDirectSuccessCount: 5,
          sourceDirectObservationCount: 5,
          edgePrivacyEpoch: 2,
          supportingSourceIds: [upperUuid],
        },
        {
          edgeId: "mixed-case-self-course-edge",
          sourceCourseId: targetCourseUuid.toUpperCase(),
          sourceConceptId: "matrices",
          targetCourseId: targetCourseUuid,
          targetConceptId: "eigenvalues",
          alignmentWeight: 0.3,
          sourceDirectSuccessCount: 5,
          sourceDirectObservationCount: 5,
          edgePrivacyEpoch: 2,
          supportingSourceIds: [],
        },
      ],
      coursePrivacyEpochs: { [courseAUuidLower]: 2, [targetCourseUuid]: 2 },
      activeCourseSharingEnabled: { [courseAUuidLower]: true, [targetCourseUuid]: true },
      revokedSourceIds: new Set<string>([lowerUuid]),
    });

    expect(mixedCaseRevoked.acceptedEdges).toHaveLength(0);
    expect(mixedCaseRevoked.posteriorMean).toBe(0.5);
    expect(mixedCaseRevoked.decoupledEdges).toEqual([
      expect.objectContaining({
        edgeId: "mixed-case-revoked-edge",
        reason: "supporting_source_revoked",
      }),
    ]);
    expect(mixedCaseRevoked.ignoredNonDirectEdges).toEqual([
      expect.objectContaining({
        edgeId: "mixed-case-self-course-edge",
        reason: "same_course_edge",
      }),
    ]);

    // Also verify mixed-case UUID lease idempotency & supersession in offline-flashcard-lease.ts!
    const leaseUuidLower = "22222222-3333-4444-8555-666666666666";
    const leaseUuidUpper = leaseUuidLower.toUpperCase();
    const cardUuidLower = "33333333-4444-4555-8666-777777777777";
    const cardUuidUpper = cardUuidLower.toUpperCase();
    const uuidLease = issueOfflineFlashcardLease({
      leaseId: leaseUuidUpper,
      workspaceId: courseAUuidUpper,
      learnerId: lowerUuid,
      issuedAtMs: T0,
      candidates: [{ ...makeFlashcardCandidate(1), cardId: cardUuidUpper }],
    });
    expect(uuidLease.ok).toBe(true);
    if (!uuidLease.ok) throw new Error("expected UUID lease");
    expect(uuidLease.lease.leaseId).toBe(leaseUuidLower);
    expect(uuidLease.lease.cards[0]?.cardId).toBe(cardUuidLower);

    const uuidSettle1 = reconcileOfflineLeaseOutbox({
      lease: uuidLease.lease,
      serverCards: { [cardUuidUpper]: createInitialOfflineFsrsSnapshot(cardUuidUpper, T0 - 3_600_000, 1) },
      serverReceiptAtMs: T0 + 60_000,
      entries: [
        {
          leaseId: leaseUuidLower,
          seq: 1,
          cardId: cardUuidLower,
          expectedCardRevision: 1,
          rating: "good",
        },
      ],
    });
    expect(uuidSettle1.ok).toBe(true);
    if (!uuidSettle1.ok) throw new Error("expected UUID settle");
    expect(uuidSettle1.settledCount).toBe(1);

    // Replaying with uppercase UUIDs MUST match the canonicalized ledger entry ("replayed", zero double mutation).
    const uuidReplay = reconcileOfflineLeaseOutbox({
      lease: uuidLease.lease,
      serverCards: uuidSettle1.updatedServerCards,
      processedLedger: uuidSettle1.nextProcessedLedger,
      serverReceiptAtMs: T0 + 120_000,
      entries: [
        {
          leaseId: leaseUuidUpper,
          seq: 1,
          cardId: cardUuidUpper,
          expectedCardRevision: 1,
          rating: "good",
        },
      ],
    });
    expect(uuidReplay.ok).toBe(true);
    if (!uuidReplay.ok) throw new Error("expected UUID replay");
    expect(uuidReplay.replayedCount).toBe(1);
    expect(uuidReplay.settledCount).toBe(0);

    // [Round-8 P2] Pre-Round-7 stored ledger entry whose payloadFingerprint was hashed from
    // raw uppercase UUIDs MUST replay idempotently (both uppercase and lowercase retries),
    // while genuine payload mutations STILL return 409 seq_payload_mismatch!
    const preR7LeaseUuidLower = "44444444-5555-4666-8777-888888888888";
    const preR7LeaseUuidUpper = preR7LeaseUuidLower.toUpperCase();
    const preR7CardUuidLower = "55555555-6666-4777-8888-999999999999";
    const preR7CardUuidUpper = preR7CardUuidLower.toUpperCase();
    const preR7EntryUpper = {
      leaseId: preR7LeaseUuidUpper,
      seq: 1,
      cardId: preR7CardUuidUpper,
      expectedCardRevision: 1,
      rating: "good" as const,
    };
    // Simulate a legacy pre-Round-7 SHA-256 fingerprint computed over raw uppercase UUIDs
    // (before canonicalizeIdentifier lowercased UUIDs).
    const preR7CanonicalJson = `{"cardId":"${preR7CardUuidUpper}","expectedCardRevision":1,"leaseId":"${preR7LeaseUuidUpper}","rating":"good","seq":1}`;
    const preR7DigestBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preR7CanonicalJson)),
    );
    const preR7RawUppercaseFingerprint = [...preR7DigestBytes]
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    const preR7Lease = issueOfflineFlashcardLease({
      leaseId: preR7LeaseUuidUpper,
      workspaceId: courseAUuidUpper,
      learnerId: lowerUuid,
      issuedAtMs: T0,
      candidates: [{ ...makeFlashcardCandidate(1), cardId: preR7CardUuidUpper }],
    });
    if (!preR7Lease.ok) throw new Error("expected preR7 lease");

    const preR7ReceiptSnapshot = {
      ...createInitialOfflineFsrsSnapshot(preR7CardUuidLower, T0 + 60_000, 2),
      lastServerReviewedAtMs: T0 + 60_000,
    };
    const legacyLedger = {
      [`${preR7LeaseUuidUpper}:1`]: {
        leaseId: preR7LeaseUuidUpper,
        seq: 1,
        payloadFingerprint: preR7RawUppercaseFingerprint,
        receipt: {
          leaseId: preR7LeaseUuidUpper,
          seq: 1,
          cardId: preR7CardUuidUpper,
          rawRating: "good" as const,
          effectiveRating: "good" as const,
          clampedFromEasy: false,
          authorityClock: "server_receipt" as const,
          effectiveReviewedAtMs: T0 + 60_000,
          delayedCheckMinted: false as const,
          allowMasteryPromotion: false as const,
          transferVerified: false as const,
          strippedClientFlags: [],
          previousRevision: 1,
          newRevision: 2,
          nextSnapshot: preR7ReceiptSnapshot,
        },
      },
    };

    const legacyReplayUpper = reconcileOfflineLeaseOutbox({
      lease: preR7Lease.lease,
      serverCards: { [preR7CardUuidLower]: preR7ReceiptSnapshot },
      processedLedger: legacyLedger,
      serverReceiptAtMs: T0 + 120_000,
      entries: [preR7EntryUpper],
    });
    expect(legacyReplayUpper.ok).toBe(true);
    if (!legacyReplayUpper.ok) throw new Error("expected legacy uppercase replay");
    expect(legacyReplayUpper.replayedCount).toBe(1);
    expect(legacyReplayUpper.results[0]?.outcome).toBe("replayed");

    const legacyReplayLower = reconcileOfflineLeaseOutbox({
      lease: preR7Lease.lease,
      serverCards: { [preR7CardUuidLower]: preR7ReceiptSnapshot },
      processedLedger: legacyLedger,
      serverReceiptAtMs: T0 + 120_000,
      entries: [
        {
          leaseId: preR7LeaseUuidLower,
          seq: 1,
          cardId: preR7CardUuidLower,
          expectedCardRevision: 1,
          rating: "good",
        },
      ],
    });
    expect(legacyReplayLower.ok).toBe(true);
    if (!legacyReplayLower.ok) throw new Error("expected legacy lowercase replay");
    expect(legacyReplayLower.replayedCount).toBe(1);
    expect(legacyReplayLower.results[0]?.outcome).toBe("replayed");

    const legacyMutatedConflict = reconcileOfflineLeaseOutbox({
      lease: preR7Lease.lease,
      serverCards: { [preR7CardUuidLower]: preR7ReceiptSnapshot },
      processedLedger: legacyLedger,
      serverReceiptAtMs: T0 + 120_000,
      entries: [{ ...preR7EntryUpper, rating: "hard" }],
    });
    expect(legacyMutatedConflict.ok).toBe(true);
    if (!legacyMutatedConflict.ok) throw new Error("expected conflict response");
    expect(legacyMutatedConflict.results[0]).toMatchObject({
      outcome: "seq_payload_mismatch",
      httpStatus: 409,
    });
  });
});
