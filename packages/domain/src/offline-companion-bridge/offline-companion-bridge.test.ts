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
  computeOfflineOutboxPayloadFingerprint,
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

    // [Round-9 P1-1] Binary `+`/`-` spacing around function/identifier/LaTeX operands
    // (`sin(x) + cos(x)` <-> `sin(x)+cos(x)`, `f(x) - g(x)` <-> `f(x)-g(x)`, `\alpha + \beta` <-> `\alpha+\beta`)
    // MUST be caught in BOTH flashcard backSummary/prompt AND miss_variant stem!
    expect(containsAnswerLeak("Remember sin(x)+cos(x) here.", "sin(x) + cos(x)")).toBe(true);
    expect(containsAnswerLeak("Remember sin(x) + cos(x) here.", "sin(x)+cos(x)")).toBe(true);
    expect(containsAnswerLeak("Check sin(x)+cos(x)-tan(x).", "sin(x) + cos(x) - tan(x)")).toBe(true);
    expect(containsAnswerLeak("Check sin(x) + cos(x) - tan(x).", "sin(x)+cos(x)-tan(x)")).toBe(true);
    expect(containsAnswerLeak("Evaluate f(x)-g(x) at zero.", "f(x) - g(x)")).toBe(true);
    expect(containsAnswerLeak("Evaluate f(x) - g(x) at zero.", "f(x)-g(x)")).toBe(true);
    expect(containsAnswerLeak("Sum equals \\alpha+\\beta.", "\\alpha + \\beta")).toBe(true);
    expect(containsAnswerLeak("Sum equals \\alpha + \\beta.", "\\alpha+\\beta")).toBe(true);

    for (const [idx, fnCase] of [
      { answerKey: "sin(x) + cos(x)", stem: "Compute derivative yielding sin(x)+cos(x)." },
      { answerKey: "sin(x)+cos(x)", stem: "Compute derivative yielding sin(x) + cos(x)." },
      { answerKey: "f(x) - g(x)", stem: "Note that f(x)-g(x) vanishes." },
      { answerKey: "f(x)-g(x)", stem: "Note that f(x) - g(x) vanishes." },
    ].entries()) {
      const fnMiss = issueOfflineFlashcardLease({
        leaseId: `lease-r9-fn-miss-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: fnCase.answerKey,
            freshVariantStem: fnCase.stem,
          }),
        ],
      });
      expect(fnMiss.ok).toBe(false);
      if (!fnMiss.ok) {
        expect(fnMiss.httpStatus).toBe(422);
        expect(fnMiss.code).toBe("miss_variant_answer_leak");
      }

      const fnFlashcard = issueOfflineFlashcardLease({
        leaseId: `lease-r9-fn-fc-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({ answerKey: fnCase.answerKey }),
          {
            ...makeFlashcardCandidate(500 + idx),
            prompt: "Review trig sum identity.",
            backSummary: fnCase.stem,
          },
        ],
      });
      expect(fnFlashcard.ok).toBe(false);
      if (!fnFlashcard.ok) {
        expect(fnFlashcard.httpStatus).toBe(422);
        expect(fnFlashcard.code).toBe("miss_variant_answer_leak");
      }
    }

    // [Round-9 P1-2] Reserved JS prototype-chain property keys (`__proto__`, `constructor`, `prototype`)
    // MUST fail closed on lease issuance, settlement, companion pairing, and cross-course bridge!
    for (const reservedKey of ["__proto__", "constructor", "prototype"]) {
      const badCardLease = issueOfflineFlashcardLease({
        leaseId: "lease-r9-reserved-card",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [{ ...makeFlashcardCandidate(1), cardId: reservedKey }],
      });
      expect(badCardLease.ok).toBe(false);
      if (!badCardLease.ok) {
        expect(badCardLease.httpStatus).toBe(400);
        expect(badCardLease.code).toBe("invalid_card_payload");
      }

      const badScopeLease = issueOfflineFlashcardLease({
        leaseId: reservedKey,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [makeFlashcardCandidate(1)],
      });
      expect(badScopeLease.ok).toBe(false);
      if (!badScopeLease.ok) {
        expect(badScopeLease.httpStatus).toBe(400);
        expect(badScopeLease.code).toBe("invalid_lease_scope");
      }

      const badPairOffer = createCompanionPairingOffer({
        offerId: "offer-r9",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        attemptId: reservedKey,
        primaryOrigin: "https://app.aistudy.example",
        allowedCompanionOrigin: "https://companion.aistudy-sandbox.example",
        issuedAtMs: T0,
        deviceCode: "dev_code_9f8a7b6c5d4e3f2a1b0c",
        userCode: "AB23-CD45",
        fragmentSecret: "ephemeral_frag_secret_77aa88bb99cc",
      });
      expect(badPairOffer.ok).toBe(false);
      if (!badPairOffer.ok) expect(badPairOffer.code).toBe("invalid_pairing_scope");
    }

    // Even if a tampered outbox attempts to settle cardId="__proto__" / "constructor" / "prototype",
    // reconcileOfflineLeaseOutbox fails closed with 400 invalid_entry and never mutates Object.prototype!
    const safeLease = issueOfflineFlashcardLease({
      leaseId: "lease-r9-settle-guard",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [makeFlashcardCandidate(1)],
    });
    if (!safeLease.ok) throw new Error("expected safe lease");
    const safeSettle = reconcileOfflineLeaseOutbox({
      lease: safeLease.lease,
      serverCards: { "card-1": createInitialOfflineFsrsSnapshot("card-1", T0 - 3_600_000, 1) },
      serverReceiptAtMs: T0 + 60_000,
      entries: [
        { leaseId: "lease-r9-settle-guard", seq: 1, cardId: "__proto__", expectedCardRevision: 1, rating: "good" },
        { leaseId: "lease-r9-settle-guard", seq: 2, cardId: "constructor", expectedCardRevision: 1, rating: "good" },
        { leaseId: "lease-r9-settle-guard", seq: 3, cardId: "prototype", expectedCardRevision: 1, rating: "good" },
      ],
    });
    expect(safeSettle.ok).toBe(true);
    if (!safeSettle.ok) throw new Error("expected settle response");
    expect(safeSettle.settledCount).toBe(0);
    expect(safeSettle.results.every(r => r.outcome === "invalid_entry" && r.httpStatus === 400)).toBe(true);
    expect(Object.getPrototypeOf(safeSettle.updatedServerCards)).toBeNull();
    expect(Object.getPrototypeOf(safeSettle.nextProcessedLedger)).toBeNull();

    // [Round-10 P1-1] Binary `+`/`-` operand boundaries MUST include `}`, `{`, `|`, and `'`/`′`
    // so LaTeX fraction sums (`\frac{1}{2} + \frac{1}{3}` <-> `\frac{1}{2}+\frac{1}{3}`),
    // brace-grouped terms (`{x}^2 + {y}^2` <-> `{x}^2+{y}^2`), absolute values (`|x| + |y|` <-> `|x|+|y|`),
    // and primed derivatives (`f'(x) + g'(x)` / `x' + y'`) are blocked in BOTH directions while keeping
    // standalone signed literals (`"-4"`) non-false-positive on binary subtraction.
    expect(containsAnswerLeak("Compute \\frac{1}{2}+\\frac{1}{3} exactly.", "\\frac{1}{2} + \\frac{1}{3}")).toBe(true);
    expect(containsAnswerLeak("Compute \\frac{1}{2} + \\frac{1}{3} exactly.", "\\frac{1}{2}+\\frac{1}{3}")).toBe(true);
    expect(containsAnswerLeak("Evaluate \\frac{1}{2}-\\frac{1}{3} here.", "\\frac{1}{2} - \\frac{1}{3}")).toBe(true);
    expect(containsAnswerLeak("Evaluate \\frac{1}{2} - \\frac{1}{3} here.", "\\frac{1}{2}-\\frac{1}{3}")).toBe(true);
    expect(containsAnswerLeak("其值为\\frac{1}{2}+\\frac{1}{3}。", "\\frac{1}{2} + \\frac{1}{3}")).toBe(true);
    expect(containsAnswerLeak("Simplify {x}^2+{y}^2 first.", "{x}^2 + {y}^2")).toBe(true);
    expect(containsAnswerLeak("Simplify {x}^2 + {y}^2 first.", "{x}^2+{y}^2")).toBe(true);
    expect(containsAnswerLeak("Bound |x|+|y| tightly.", "|x| + |y|")).toBe(true);
    expect(containsAnswerLeak("Bound |x| + |y| tightly.", "|x|+|y|")).toBe(true);
    expect(containsAnswerLeak("Check f'(x)+g'(x) at x=0.", "f'(x) + g'(x)")).toBe(true);
    expect(containsAnswerLeak("Check f'(x) + g'(x) at x=0.", "f'(x)+g'(x)")).toBe(true);
    expect(containsAnswerLeak("Recall x'+y' holds.", "x' + y'")).toBe(true);
    expect(containsAnswerLeak("Recall x' + y' holds.", "x'+y'")).toBe(true);
    expect(containsAnswerLeak("Solve x^2 - 4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("Solve {x}^2 - 4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("Solve |x| - 4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("Solve {x} \u2212 4 = 0", "-4")).toBe(false);

    for (const [idx, braceCase] of [
      { answerKey: "\\frac{1}{2} + \\frac{1}{3}", stem: "Evaluate \\frac{1}{2}+\\frac{1}{3} directly." },
      { answerKey: "\\frac{1}{2}+\\frac{1}{3}", stem: "Evaluate \\frac{1}{2} + \\frac{1}{3} directly." },
      { answerKey: "{x}^2 + {y}^2", stem: "Expand {x}^2+{y}^2 cleanly." },
      { answerKey: "{x}^2+{y}^2", stem: "Expand {x}^2 + {y}^2 cleanly." },
      { answerKey: "|x| + |y|", stem: "By triangle inequality, bound |x|+|y|." },
      { answerKey: "|x|+|y|", stem: "By triangle inequality, bound |x| + |y|." },
    ].entries()) {
      const rejectedBraceMiss = issueOfflineFlashcardLease({
        leaseId: `lease-r10-brace-miss-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: braceCase.answerKey,
            freshVariantStem: braceCase.stem,
          }),
        ],
      });
      expect(rejectedBraceMiss.ok).toBe(false);
      if (!rejectedBraceMiss.ok) {
        expect(rejectedBraceMiss.httpStatus).toBe(422);
        expect(rejectedBraceMiss.code).toBe("miss_variant_answer_leak");
      }

      const rejectedBraceFlashcard = issueOfflineFlashcardLease({
        leaseId: `lease-r10-brace-fc-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({ answerKey: braceCase.answerKey }),
          {
            ...makeFlashcardCandidate(600 + idx),
            prompt: "Review LaTeX sum identity.",
            backSummary: braceCase.stem,
          },
        ],
      });
      expect(rejectedBraceFlashcard.ok).toBe(false);
      if (!rejectedBraceFlashcard.ok) {
        expect(rejectedBraceFlashcard.httpStatus).toBe(422);
        expect(rejectedBraceFlashcard.code).toBe("miss_variant_answer_leak");
      }
    }

    // [Round-10 P1-2] Pre-existing legacy own-property snapshots (`constructor`, `prototype`, and own
    // enumerable `__proto__`) on `serverCards` and `processedLedger` MUST be preserved intact on the
    // `Object.create(null)` output maps during reconciliation (both when 0 entries settle and when valid
    // sibling cards settle), while incoming outbox entries targeting reserved keys STILL fail closed with
    // `400 invalid_entry` and `Object.prototype` is never mutated!
    const validCard1Snap = createInitialOfflineFsrsSnapshot("card-1", T0 - 3_600_000, 1);
    const legacyCtorSnap: ServerFlashcardSnapshot = { ...validCard1Snap, cardId: "constructor", revision: 4 };
    const legacyProtoSnap: ServerFlashcardSnapshot = { ...validCard1Snap, cardId: "prototype", revision: 7 };
    const legacyDunderSnap: ServerFlashcardSnapshot = { ...validCard1Snap, cardId: "__proto__", revision: 9 };
    const legacyServerCards: Record<string, ServerFlashcardSnapshot> = {
      "card-1": validCard1Snap,
      constructor: legacyCtorSnap,
      prototype: legacyProtoSnap,
    };
    Object.defineProperty(legacyServerCards, "__proto__", {
      value: legacyDunderSnap,
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const legacyCtorLedgerEntry = {
      leaseId: "constructor",
      seq: 1,
      payloadFingerprint: "a".repeat(64),
      receipt: {
        leaseId: "constructor",
        seq: 1,
        cardId: "constructor",
        rawRating: "good" as const,
        effectiveRating: "good" as const,
        clampedFromEasy: false,
        authorityClock: "server_receipt" as const,
        effectiveReviewedAtMs: T0 - 60_000,
        delayedCheckMinted: false as const,
        allowMasteryPromotion: false as const,
        transferVerified: false as const,
        strippedClientFlags: [],
        previousRevision: 3,
        newRevision: 4,
        nextSnapshot: legacyCtorSnap,
      },
    };
    const legacyProcessedLedger = {
      "constructor:1": legacyCtorLedgerEntry,
    };

    // Case 1: 0 entries settle (empty batch) -> all pre-existing own-property snapshots preserved verbatim.
    const zeroSettleLegacy = reconcileOfflineLeaseOutbox({
      lease: safeLease.lease,
      serverCards: legacyServerCards,
      processedLedger: legacyProcessedLedger,
      serverReceiptAtMs: T0 + 60_000,
      entries: [],
    });
    expect(zeroSettleLegacy.ok).toBe(true);
    if (!zeroSettleLegacy.ok) throw new Error("expected zero-settle legacy reconcile");
    expect(zeroSettleLegacy.settledCount).toBe(0);
    expect(Object.getPrototypeOf(zeroSettleLegacy.updatedServerCards)).toBeNull();
    expect(Object.getPrototypeOf(zeroSettleLegacy.nextProcessedLedger)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(zeroSettleLegacy.updatedServerCards, "constructor")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(zeroSettleLegacy.updatedServerCards, "prototype")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(zeroSettleLegacy.updatedServerCards, "__proto__")).toBe(true);
    expect(zeroSettleLegacy.updatedServerCards["constructor"]).toEqual(legacyCtorSnap);
    expect(zeroSettleLegacy.updatedServerCards["prototype"]).toEqual(legacyProtoSnap);
    expect(zeroSettleLegacy.updatedServerCards["__proto__"]).toEqual(legacyDunderSnap);
    expect(Object.prototype.hasOwnProperty.call(zeroSettleLegacy.nextProcessedLedger, "constructor:1")).toBe(true);
    expect(zeroSettleLegacy.nextProcessedLedger["constructor:1"]).toEqual(legacyCtorLedgerEntry);

    // Case 2: Valid sibling "card-1" settles alongside rejected reserved-key outbox entries ->
    // "card-1" advances, reserved-key entries fail closed with 400 invalid_entry, and pre-existing
    // own-property "constructor"/"prototype"/"__proto__" snapshots stay intact with zero Object.prototype mutation.
    const mixedSettleLegacy = reconcileOfflineLeaseOutbox({
      lease: safeLease.lease,
      serverCards: legacyServerCards,
      processedLedger: legacyProcessedLedger,
      serverReceiptAtMs: T0 + 60_000,
      entries: [
        { leaseId: "lease-r9-settle-guard", seq: 1, cardId: "card-1", expectedCardRevision: 1, rating: "good" },
        { leaseId: "lease-r9-settle-guard", seq: 2, cardId: "__proto__", expectedCardRevision: 9, rating: "good" },
        { leaseId: "lease-r9-settle-guard", seq: 3, cardId: "constructor", expectedCardRevision: 4, rating: "good" },
        { leaseId: "lease-r9-settle-guard", seq: 4, cardId: "prototype", expectedCardRevision: 7, rating: "good" },
      ],
    });
    expect(mixedSettleLegacy.ok).toBe(true);
    if (!mixedSettleLegacy.ok) throw new Error("expected mixed-settle legacy reconcile");
    expect(mixedSettleLegacy.settledCount).toBe(1);
    expect(mixedSettleLegacy.results[0]).toMatchObject({ cardId: "card-1", outcome: "settled", httpStatus: 200 });
    expect(mixedSettleLegacy.results.slice(1).every(r => r.outcome === "invalid_entry" && r.httpStatus === 400)).toBe(true);
    expect(mixedSettleLegacy.updatedServerCards["card-1"]?.revision).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(mixedSettleLegacy.updatedServerCards, "constructor")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(mixedSettleLegacy.updatedServerCards, "prototype")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(mixedSettleLegacy.updatedServerCards, "__proto__")).toBe(true);
    expect(mixedSettleLegacy.updatedServerCards["constructor"]).toEqual(legacyCtorSnap);
    expect(mixedSettleLegacy.updatedServerCards["prototype"]).toEqual(legacyProtoSnap);
    expect(mixedSettleLegacy.updatedServerCards["__proto__"]).toEqual(legacyDunderSnap);
    expect(Object.prototype.hasOwnProperty.call(mixedSettleLegacy.nextProcessedLedger, "constructor:1")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(mixedSettleLegacy.nextProcessedLedger, "lease-r9-settle-guard:1")).toBe(true);
    expect(Object.getPrototypeOf(mixedSettleLegacy.updatedServerCards)).toBeNull();
    expect(Object.prototype.constructor).toBe(Object);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "prototype")).toBe(false);

    // Case 3: Structurally invalid pre-existing snapshot fails closed (throws TypeError) instead of silently dropping!
    expect(() =>
      reconcileOfflineLeaseOutbox({
        lease: safeLease.lease,
        serverCards: {
          "card-1": validCard1Snap,
          constructor: { broken: true } as unknown as ServerFlashcardSnapshot,
        },
        serverReceiptAtMs: T0 + 60_000,
        entries: [],
      }),
    ).toThrow(TypeError);

    // [Round-11 P1-1] Non-finite or non-number clientReviewedAtMs (NaN, Infinity, -Infinity, string)
    // MUST fail closed with 400 invalid_entry BEFORE settling so nextProcessedLedger is NEVER poisoned
    // and subsequent reconciliations succeed cleanly!
    const badClientClockRes = reconcileOfflineLeaseOutbox({
      lease: safeLease.lease,
      serverCards: { "card-1": validCard1Snap },
      serverReceiptAtMs: T0 + 60_000,
      entries: [
        {
          leaseId: "lease-r9-settle-guard",
          seq: 1,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "good",
          clientReviewedAtMs: Number.NaN,
        },
        {
          leaseId: "lease-r9-settle-guard",
          seq: 2,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "good",
          clientReviewedAtMs: Number.POSITIVE_INFINITY,
        },
        {
          leaseId: "lease-r9-settle-guard",
          seq: 3,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "good",
          clientReviewedAtMs: Number.NEGATIVE_INFINITY,
        },
        {
          leaseId: "lease-r9-settle-guard",
          seq: 4,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "good",
          clientReviewedAtMs: "2026-11-21" as unknown as number,
        },
      ],
    });
    expect(badClientClockRes.ok).toBe(true);
    if (!badClientClockRes.ok) throw new Error("expected bad client clock response");
    expect(badClientClockRes.settledCount).toBe(0);
    expect(badClientClockRes.results).toHaveLength(4);
    expect(badClientClockRes.results.every(r => r.outcome === "invalid_entry" && r.httpStatus === 400)).toBe(true);
    expect(Object.keys(badClientClockRes.nextProcessedLedger)).toHaveLength(0);

    // Follow-up reconciliation with a valid entry (clientReviewedAtMs omitted -> normalized to null)
    // succeeds cleanly, and a subsequent reconciliation loading nextProcessedLedger does NOT throw!
    const followUpValidSettle = reconcileOfflineLeaseOutbox({
      lease: safeLease.lease,
      serverCards: badClientClockRes.updatedServerCards,
      processedLedger: badClientClockRes.nextProcessedLedger,
      serverReceiptAtMs: T0 + 120_000,
      entries: [
        {
          leaseId: "lease-r9-settle-guard",
          seq: 1,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "good",
        },
      ],
    });
    expect(followUpValidSettle.ok).toBe(true);
    if (!followUpValidSettle.ok) throw new Error("expected follow-up valid settle");
    expect(followUpValidSettle.settledCount).toBe(1);
    expect(
      followUpValidSettle.nextProcessedLedger["lease-r9-settle-guard:1"]?.payloadSummary?.clientReviewedAtMs,
    ).toBeNull();

    const followUpReload = reconcileOfflineLeaseOutbox({
      lease: safeLease.lease,
      serverCards: followUpValidSettle.updatedServerCards,
      processedLedger: followUpValidSettle.nextProcessedLedger,
      serverReceiptAtMs: T0 + 180_000,
      entries: [
        {
          leaseId: "lease-r9-settle-guard",
          seq: 1,
          cardId: "card-1",
          expectedCardRevision: 1,
          rating: "good",
        },
      ],
    });
    expect(followUpReload.ok).toBe(true);
    if (!followUpReload.ok) throw new Error("expected clean reload replay");
    expect(followUpReload.replayedCount).toBe(1);

    // [Round-11 P1-2] Conflicting case-alias UUID keys in serverCards OR processedLedger MUST throw
    // TypeError fail-closed instead of letting a later stale snapshot overwrite a newer revision!
    const aliasUuidUpper = "550E8400-E29B-41D4-A716-446655440000";
    const aliasUuidLower = "550e8400-e29b-41d4-a716-446655440000";
    const aliasSnapRev3 = createInitialOfflineFsrsSnapshot(aliasUuidUpper, T0 - 3_600_000, 3);
    const aliasSnapRev1 = createInitialOfflineFsrsSnapshot(aliasUuidLower, T0 - 3_600_000, 1);

    expect(() =>
      reconcileOfflineLeaseOutbox({
        lease: safeLease.lease,
        serverCards: {
          [aliasUuidUpper]: aliasSnapRev3,
          [aliasUuidLower]: aliasSnapRev1,
        },
        serverReceiptAtMs: T0 + 60_000,
        entries: [],
      }),
    ).toThrow(TypeError);

    expect(() =>
      reconcileOfflineLeaseOutbox({
        lease: safeLease.lease,
        serverCards: new Map([
          [aliasUuidUpper, aliasSnapRev3],
          [aliasUuidLower, aliasSnapRev1],
        ]),
        serverReceiptAtMs: T0 + 60_000,
        entries: [],
      }),
    ).toThrow(TypeError);

    const aliasLedgerUpper = {
      ...legacyCtorLedgerEntry,
      leaseId: aliasUuidUpper,
      seq: 1,
      receipt: {
        ...legacyCtorLedgerEntry.receipt,
        leaseId: aliasUuidUpper,
        cardId: aliasUuidUpper,
        previousRevision: 2,
        newRevision: 3,
        nextSnapshot: aliasSnapRev3,
      },
    };
    const aliasLedgerLower = {
      ...legacyCtorLedgerEntry,
      leaseId: aliasUuidLower,
      seq: 1,
      receipt: {
        ...legacyCtorLedgerEntry.receipt,
        leaseId: aliasUuidLower,
        cardId: aliasUuidLower,
        previousRevision: 0,
        newRevision: 1,
        nextSnapshot: aliasSnapRev1,
      },
    };
    expect(() =>
      reconcileOfflineLeaseOutbox({
        lease: safeLease.lease,
        serverCards: { "card-1": validCard1Snap },
        processedLedger: {
          [`${aliasUuidUpper}:1`]: aliasLedgerUpper,
          [`${aliasUuidLower}:1`]: aliasLedgerLower,
        },
        serverReceiptAtMs: T0 + 60_000,
        entries: [],
      }),
    ).toThrow(TypeError);

    // [Round-11 P1-3] Short plain-text protected answers (< 6 chars: "Paris", "Mars", "ATP", "ox", "1914", "πr")
    // AND short CJK answers ("巴黎", "线粒体", "光合作用", "秦") MUST be caught at Unicode/script boundaries
    // without false-positiving on embedded substrings ("par" vs "compare"/"paragraph", "art" vs "part"/"start",
    // "A" vs "A student solved the problem")!
    expect(containsAnswerLeak("Use Paris as the example.", "Paris")).toBe(true);
    expect(containsAnswerLeak("答案是Paris。", "Paris")).toBe(true);
    expect(containsAnswerLeak("Visit Mars on the next mission.", "Mars")).toBe(true);
    expect(containsAnswerLeak("Cells synthesize ATP for energy.", "ATP")).toBe(true);
    expect(containsAnswerLeak("The ox pulled the plow.", "ox")).toBe(true);
    expect(containsAnswerLeak("In 1914, the conflict began.", "1914")).toBe(true);
    expect(containsAnswerLeak("Compute semicircle length πr directly.", "πr")).toBe(true);
    expect(containsAnswerLeak("Answer: art.", "art")).toBe(true);
    expect(containsAnswerLeak("例如巴黎盆地的地形特征", "巴黎")).toBe(true);
    expect(containsAnswerLeak("简述线粒体的结构特点", "线粒体")).toBe(true);
    expect(containsAnswerLeak("绿色植物进行光合作用的场所", "光合作用")).toBe(true);
    expect(containsAnswerLeak("统一六国的是秦朝", "秦")).toBe(true);

    // Zero false positives on embedded words or indefinite article "A":
    expect(containsAnswerLeak("Compare the two paragraphs carefully.", "par")).toBe(false);
    expect(containsAnswerLeak("Start from part two of the proof.", "art")).toBe(false);
    expect(containsAnswerLeak("Oxygen reacts with iron oxide in a box.", "ox")).toBe(false);
    expect(containsAnswerLeak("Parisian architecture influenced Europe.", "Paris")).toBe(false);
    expect(containsAnswerLeak("A student solved the problem cleanly.", "A")).toBe(false);
    expect(containsAnswerLeak("Read the pirate story.", "πr")).toBe(false);

    for (const [idx, shortTextCase] of [
      { answerKey: "Paris", stem: "Use Paris as the example city." },
      { answerKey: "ATP", stem: "Cells store chemical energy in ATP." },
      { answerKey: "巴黎", stem: "例如巴黎盆地的气候类型。" },
      { answerKey: "线粒体", stem: "比较线粒体与叶绿体的结构。" },
    ].entries()) {
      const shortTextMiss = issueOfflineFlashcardLease({
        leaseId: `lease-r11-short-miss-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: shortTextCase.answerKey,
            freshVariantStem: shortTextCase.stem,
          }),
        ],
      });
      expect(shortTextMiss.ok).toBe(false);
      if (!shortTextMiss.ok) {
        expect(shortTextMiss.httpStatus).toBe(422);
        expect(shortTextMiss.code).toBe("miss_variant_answer_leak");
      }

      const shortTextFc = issueOfflineFlashcardLease({
        leaseId: `lease-r11-short-fc-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({ answerKey: shortTextCase.answerKey }),
          {
            ...makeFlashcardCandidate(700 + idx),
            prompt: "Review chapter concept.",
            backSummary: shortTextCase.stem,
          },
        ],
      });
      expect(shortTextFc.ok).toBe(false);
      if (!shortTextFc.ok) {
        expect(shortTextFc.httpStatus).toBe(422);
        expect(shortTextFc.code).toBe("miss_variant_answer_leak");
      }
    }

    const benignParLease = issueOfflineFlashcardLease({
      leaseId: "lease-r11-benign-par",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        makeMissVariantCandidate({
          answerKey: "par",
          freshVariantStem: "Compare the two paragraphs and start from part one.",
        }),
      ],
    });
    expect(benignParLease.ok).toBe(true);

    // [Round-11 P2] Binary Unicode minus (`\u2212`) after prime marks (`'`, `′`, `’`) MUST NOT
    // collapse into unary `-4`, while compound prime expressions (`x′ − y′` <-> `x′-y′`, `f'(x) − g'(x)`)
    // MUST still match symmetrically!
    expect(containsAnswerLeak("Solve x\u2032 \u2212 4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("Solve x' \u2212 4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("Solve x\u2019 \u2212 4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("Solve f'(x) \u2212 4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("Evaluate x\u2032 \u2212 y\u2032 here.", "x\u2032-y\u2032")).toBe(true);
    expect(containsAnswerLeak("Evaluate x\u2032-y\u2032 here.", "x\u2032 \u2212 y\u2032")).toBe(true);
    expect(containsAnswerLeak("Evaluate x\u2032 \u2212 y\u2032 here.", "x'-y'")).toBe(true);
    expect(containsAnswerLeak("Evaluate f'(x) \u2212 g'(x) here.", "f'(x)-g'(x)")).toBe(true);
    expect(containsAnswerLeak("Evaluate f'(x)-g'(x) here.", "f'(x) \u2212 g'(x)")).toBe(true);
    expect(containsAnswerLeak("Evaluate x\u2019 \u2212 y\u2019 here.", "x\u2019-y\u2019")).toBe(true);

    // [Round-12 P1-1] Curly prime `\u2019` (`’`) MUST canonicalize to `'` alongside `\u2032` (`′`)
    // so cross-prime leak pairs (`x′-y′` <-> `x’ − y’`, `f’(x) + g’(x)` <-> `f'(x)+g'(x)`) are caught symmetrically!
    expect(containsAnswerLeak("Evaluate x\u2019 \u2212 y\u2019 here.", "x\u2032-y\u2032")).toBe(true);
    expect(containsAnswerLeak("Evaluate x\u2032-y\u2032 here.", "x\u2019 \u2212 y\u2019")).toBe(true);
    expect(containsAnswerLeak("Evaluate x\u2019 \u2212 y\u2019 here.", "x' - y'")).toBe(true);
    expect(containsAnswerLeak("Check f\u2019(x) + g\u2019(x) at zero.", "f'(x)+g'(x)")).toBe(true);
    expect(containsAnswerLeak("Check f'(x)+g'(x) at zero.", "f\u2019(x) + g\u2019(x)")).toBe(true);
    for (const [idx, primeCase] of [
      { answerKey: "x\u2032-y\u2032", stem: "Evaluate x\u2019 \u2212 y\u2019 directly." },
      { answerKey: "x\u2019 \u2212 y\u2019", stem: "Evaluate x\u2032-y\u2032 directly." },
    ].entries()) {
      const primeLeakMiss = issueOfflineFlashcardLease({
        leaseId: `lease-r12-prime-miss-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: primeCase.answerKey,
            freshVariantStem: primeCase.stem,
          }),
        ],
      });
      expect(primeLeakMiss.ok).toBe(false);
      if (!primeLeakMiss.ok) {
        expect(primeLeakMiss.httpStatus).toBe(422);
        expect(primeLeakMiss.code).toBe("miss_variant_answer_leak");
      }
    }

    // [Round-12 P1-2] serverCards map key MUST agree with embedded snapshot.cardId after canonicalization,
    // and processedLedger key/entry/receipt/nextSnapshot identities MUST agree (throwing TypeError before settling)!
    const cardBSnap = createInitialOfflineFsrsSnapshot("card-2", T0 - 3_600_000, 5);
    expect(() =>
      reconcileOfflineLeaseOutbox({
        lease: safeLease.lease,
        serverCards: { "card-1": cardBSnap },
        serverReceiptAtMs: T0 + 60_000,
        entries: [
          { leaseId: "lease-r9-settle-guard", seq: 1, cardId: "card-1", expectedCardRevision: 1, rating: "good" },
        ],
      }),
    ).toThrow(TypeError);

    expect(() =>
      reconcileOfflineLeaseOutbox({
        lease: safeLease.lease,
        serverCards: new Map([["card-1", cardBSnap]]),
        serverReceiptAtMs: T0 + 60_000,
        entries: [],
      }),
    ).toThrow(TypeError);

    expect(() =>
      reconcileOfflineLeaseOutbox({
        lease: safeLease.lease,
        serverCards: { "card-1": validCard1Snap },
        processedLedger: { "other-lease:1": legacyCtorLedgerEntry },
        serverReceiptAtMs: T0 + 60_000,
        entries: [],
      }),
    ).toThrow(TypeError);

    expect(() =>
      reconcileOfflineLeaseOutbox({
        lease: safeLease.lease,
        serverCards: { "card-1": validCard1Snap },
        processedLedger: {
          "constructor:1": {
            ...legacyCtorLedgerEntry,
            receipt: { ...legacyCtorLedgerEntry.receipt, cardId: "card-1" },
          },
        },
        serverReceiptAtMs: T0 + 60_000,
        entries: [],
      }),
    ).toThrow(TypeError);

    // [Round-12 P2] Unprimed math variables (`x`, `a`, `θ`, `x_1`, `x_n`, `\theta`) before spaced Unicode
    // minus (`\u2212`) MUST preserve binary subtraction (never triggering `"-4"`), while prose cues
    // (`"The answer is − 4"`, `"Answer: − 4"`, `"Result = − 4"`) remain blocked and `"x − y"` <-> `"x-y"` leaks!
    expect(containsAnswerLeak("Solve x \u2212 4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("Evaluate \u03B8 \u2212 4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("Solve a \u2212 4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("Evaluate $a \u2212 4$", "-4")).toBe(false);
    expect(containsAnswerLeak("Find x_1 \u2212 4 and x_n \u2212 4", "-4")).toBe(false);
    expect(containsAnswerLeak("Compute \\theta \u2212 4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("The answer is \u2212 4", "-4")).toBe(true);
    expect(containsAnswerLeak("The value is \u2212 4", "-4")).toBe(true);
    expect(containsAnswerLeak("Answer: \u2212 4", "-4")).toBe(true);
    expect(containsAnswerLeak("Result = \u2212 4", "-4")).toBe(true);
    expect(containsAnswerLeak("Compute x \u2212 y here.", "x-y")).toBe(true);
    expect(containsAnswerLeak("Compute x-y here.", "x \u2212 y")).toBe(true);

    const benignVarMinusLease = issueOfflineFlashcardLease({
      leaseId: "lease-r12-benign-var-minus",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        makeMissVariantCandidate({
          answerKey: "-4",
          freshVariantStem: "Solve x \u2212 4 = 0 and evaluate \u03B8 \u2212 4 = 0.",
        }),
      ],
    });
    expect(benignVarMinusLease.ok).toBe(true);

    // [Round-13 P1 & Guards]
    // 1. LaTeX spacing/display-style commands (`\quad`, `\qquad`, `\;`, `\,`, `\hspace{...}`, `\displaystyle`)
    //    MUST NOT act as left binary operands before `− 4`, while real symbols (`\theta − 4`, `\alpha − 4`) do!
    expect(containsAnswerLeak("The value is \\(\\quad \u2212 4\\).", "-4")).toBe(true);
    expect(containsAnswerLeak("The value is \\(\\qquad \u2212 4\\).", "-4")).toBe(true);
    expect(containsAnswerLeak("The value is \\; \u2212 4.", "-4")).toBe(true);
    expect(containsAnswerLeak("The value is \\, \u2212 4.", "-4")).toBe(true);
    expect(containsAnswerLeak("The value is \\(\\hspace{1em} \u2212 4\\).", "-4")).toBe(true);
    expect(containsAnswerLeak("Evaluate \\(\\displaystyle \u2212 4\\).", "-4")).toBe(true);
    expect(containsAnswerLeak("Compute \\theta \u2212 4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("Compute \\alpha \u2212 4 = 0", "-4")).toBe(false);

    const latexQuadLeak = issueOfflineFlashcardLease({
      leaseId: "lease-r13-latex-quad-leak",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        makeMissVariantCandidate({
          answerKey: "-4",
          freshVariantStem: "The value is \\(\\quad \u2212 4\\).",
        }),
      ],
    });
    expect(latexQuadLeak.ok).toBe(false);
    if (!latexQuadLeak.ok) {
      expect(latexQuadLeak.httpStatus).toBe(422);
      expect(latexQuadLeak.code).toBe("miss_variant_answer_leak");
    }

    // 2. One-sided binary subtraction (`Solve x −4 = 0` / `Solve x -4 = 0`) MUST NOT false-positive on `"-4"`,
    //    while standalone unary `"-4"` in `"The value is -4"` / `"Answer: −4"` remains blocked!
    expect(containsAnswerLeak("Solve x \u22124 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("Solve x -4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("Solve x^2 -4 = 0", "-4")).toBe(false);
    expect(containsAnswerLeak("The value is -4", "-4")).toBe(true);
    expect(containsAnswerLeak("Answer: \u22124", "-4")).toBe(true);

    // 3. Ledger entry with inconsistent receipt.newRevision vs receipt.nextSnapshot.revision throws TypeError!
    expect(() =>
      reconcileOfflineLeaseOutbox({
        lease: safeLease.lease,
        serverCards: { "card-1": validCard1Snap },
        processedLedger: {
          "constructor:1": {
            ...legacyCtorLedgerEntry,
            receipt: {
              ...legacyCtorLedgerEntry.receipt,
              newRevision: 99,
            },
          },
        },
        serverReceiptAtMs: T0 + 60_000,
        entries: [],
      }),
    ).toThrow(TypeError);

    // [Round-14 P1] Prose English article/pronoun (`a`, `A`, `I`) and styled LaTeX commands
    // (`\color{red}`, `\textcolor{red}{...}`, `\pagecolor{...}`, `\phantom{...}`, `\begin{aligned}`, etc.)
    // MUST NOT mask unary `-4` leakage at `issueOfflineFlashcardLease`, while algebraic binary subtraction
    // (`Solve x −4 = 0`, `Solve a − 4 = 0`, `$\theta − 4$`) remains allowed!
    for (const [idx, r14LeakStem] of [
      "Apply a \u22124 point adjustment.",
      "Apply a \u2212 4 point adjustment.",
      "Apply a - 4 point adjustment.",
      "Recorded an adjustment of a \u22124.",
      "Give a \u22124.",
      "I \u22124",
      "The value is $\\color{red} \u2212 4$.",
      "The value is $\\color{red} - 4$.",
      "The value is $\\textcolor{red}{\u2212 4}$.",
      "The value is $\\pagecolor{yellow} \u2212 4$.",
      "The value is $\\hspace{1em} \u2212 4$.",
      "The value is $\\phantom{x} \u2212 4$.",
      "The value is $\\begin{aligned} \u2212 4 \\end{aligned}$.",
      "The value is {\\color{red} \u2212 4}.",
      "The value is $\\quad \u2212 4$.",
    ].entries()) {
      expect(containsAnswerLeak(r14LeakStem, "-4")).toBe(true);
      const r14Rejected = issueOfflineFlashcardLease({
        leaseId: `lease-r14-leak-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: "-4",
            freshVariantStem: r14LeakStem,
          }),
        ],
      });
      expect(r14Rejected.ok).toBe(false);
      if (!r14Rejected.ok) {
        expect(r14Rejected.httpStatus).toBe(422);
        expect(r14Rejected.code).toBe("miss_variant_answer_leak");
      }
    }

    for (const [idx, r14BenignStem] of [
      "Solve x \u22124 = 0",
      "Solve x - 4 = 0",
      "Solve a \u2212 4 = 0",
      "Compute $\\theta \u2212 4$",
      "Evaluate $a \u2212 4$",
    ].entries()) {
      expect(containsAnswerLeak(r14BenignStem, "-4")).toBe(false);
      const r14Allowed = issueOfflineFlashcardLease({
        leaseId: `lease-r14-benign-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: "-4",
            freshVariantStem: r14BenignStem,
          }),
        ],
      });
      expect(r14Allowed.ok).toBe(true);
    }

    // [Round-15 P1-1 & P1-2] Visible LaTeX `\tag{...}` / `\tag*{...}` equation tags MUST preserve
    // their rendered inner content for leak detection without fusing into preceding operands (`x=0`),
    // and prose `a`/`A`/`I` negative answers MUST NOT be masked by a later/earlier equation separated
    // by a comma, prose words, or parenthesized side-note while contiguous algebraic relations
    // (`Solve a − 4 = 0`, `0 = a − 4`, `If a − 4 < 0, find a.`) remain allowed!
    for (const [idx, r15LeakStem] of [
      "$$x=0\\tag{-4}$$",
      "$$x=0\\tag*{-4}$$",
      "$$x=0\\tag{\u2212 4}$$",
      "$$x=0\\tag*{\\color{red} \u2212 4}$$",
      "$$x=0\\tag{- 4}$$",
      "Apply a \u22124, then solve x = 0.",
      "Apply a \u2212 4, then solve x = 0.",
      "Apply a \u22124 before solving x = 0.",
      "Apply a \u22124 where x = 0.",
      "Apply a \u22124 (x = 0).",
      "Apply a \u22124 point adjustment = 0.",
      "x = 0 and apply a \u22124.",
      "x = 0, apply a \u22124.",
      "Set x = 0 a \u22124.",
    ].entries()) {
      expect(containsAnswerLeak(r15LeakStem, "-4")).toBe(true);
      const r15Rejected = issueOfflineFlashcardLease({
        leaseId: `lease-r15-leak-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: "-4",
            freshVariantStem: r15LeakStem,
          }),
        ],
      });
      expect(r15Rejected.ok).toBe(false);
      if (!r15Rejected.ok) {
        expect(r15Rejected.httpStatus).toBe(422);
        expect(r15Rejected.code).toBe("miss_variant_answer_leak");
      }
    }

    for (const [idx, r15BenignStem] of [
      "Solve a \u2212 4 = 0",
      "0 = a \u2212 4",
      "y = 2 + a \u2212 4",
      "If a \u2212 4 < 0, find a.",
      "If a \u2212 4 != 0, find a.",
      "Solve (a \u2212 4) / 2 = 3",
      "Solve x \u22124 = 0",
      "$$x=0\\tag{1}$$",
      "$$x=0\\tag*{1}$$",
      "$$x=0\\tag{1-4}$$",
    ].entries()) {
      expect(containsAnswerLeak(r15BenignStem, "-4")).toBe(false);
      const r15Allowed = issueOfflineFlashcardLease({
        leaseId: `lease-r15-benign-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: "-4",
            freshVariantStem: r15BenignStem,
          }),
        ],
      });
      expect(r15Allowed.ok).toBe(true);
    }

    // [Round-16 P1-1 & P1-2] Prose/unit parentheses (`(°C)`, `(C)`, `(points)`, `(a)`, `(%)`, `[°C]`)
    // MUST NOT mask unary `-4` leakage outside math delimiters, while algebraic parenthesized expressions
    // and full normalized Greek letters (`zeta`, `kappa`, `iota`, `upsilon`, etc.) remain allowed!
    for (const [idx, r16LeakStem] of [
      "Temperature change (\u00B0C) \u22124.",
      "Temperature change (\u00B0C) - 4.",
      "Temperature change (\u2103) \u22124.",
      "Temperature change (C) \u22124.",
      "Temperature change (C) - 4.",
      "Score delta (points) \u22124.",
      "Score delta (points) - 4.",
      "Option (a) \u22124.",
      "Option (a) - 4.",
      "Option (a) \u22124, then solve x = 0.",
      "Step (1) \u22124.",
      "Change (%) \u22124.",
      "Price ($) \u22124.",
      "Temperature change [\u00B0C] \u22124.",
      "1) \u22124.",
      "Note (step 1) \u22124.",
    ].entries()) {
      expect(containsAnswerLeak(r16LeakStem, "-4")).toBe(true);
      const r16Rejected = issueOfflineFlashcardLease({
        leaseId: `lease-r16-leak-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: "-4",
            freshVariantStem: r16LeakStem,
          }),
        ],
      });
      expect(r16Rejected.ok).toBe(false);
      if (!r16Rejected.ok) {
        expect(r16Rejected.httpStatus).toBe(422);
        expect(r16Rejected.code).toBe("miss_variant_answer_leak");
      }
    }

    for (const [idx, r16BenignStem] of [
      "Solve a \u2212 4*\u03B6 = 0, where \u03B6 = 1\u22122.",
      "Solve a \u2212 4*\u03BA = 0, where \u03BA = 2.",
      "Solve a \u2212 4*\u03B9 = 0, where \u03B9 = 1.",
      "Solve (a \u2212 4) / 2 = 3",
      "Solve (x + 1) \u2212 4 = 0",
      "Compute (x + 1) \u2212 4.",
      "Compute (2 * x) \u2212 4.",
      "Solve (a) \u2212 4 = 0",
      "Compute f(x) \u2212 4.",
      "Compute sqrt(2) \u2212 4.",
      "Evaluate $(x) \u2212 4$",
      "Evaluate $(a + 1) \u2212 4$",
    ].entries()) {
      expect(containsAnswerLeak(r16BenignStem, "-4")).toBe(false);
      const r16Allowed = issueOfflineFlashcardLease({
        leaseId: `lease-r16-benign-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: "-4",
            freshVariantStem: r16BenignStem,
          }),
        ],
      });
      expect(r16Allowed.ok).toBe(true);
    }

    // [Round-17 P1] Compound physical/SI units and prose-labeled parentheticals/brackets outside math
    // delimiters (`Velocity change (m/s) −4.`, `Acceleration (m/s^2) −4.`, `Speed (km/h) −4.`,
    // `Rate [m/s] −4.`, `(m/s) −4.`, `Ratio (a/b) −4.`) MUST fail closed at `issueOfflineFlashcardLease`
    // across BOTH miss_variant stem and sibling flashcard prompt surfaces, while genuine math remains allowed!
    for (const [idx, r17LeakText] of [
      "Velocity change (m/s) \u22124.",
      "Velocity change (m/s) - 4.",
      "Velocity change (m/s) \u2212 4.",
      "Speed (km/h) \u22124.",
      "Acceleration (m/s^2) \u22124.",
      "Acceleration (m/s\u00B2) \u22124.",
      "Density (g/cm^3) \u22124.",
      "Concentration (mol/L) \u22124.",
      "Pressure (N/m^2) \u22124.",
      "Rate [m/s] \u22124.",
      "Energy (kJ/mol) \u22124.",
      "Torque (N\u00B7m) \u22124.",
      "Force (kg*m/s^2) \u22124.",
      "Ratio (a/b) \u22124.",
      "(m/s) \u22124.",
      "(m/s) - 4.",
      "(N/m^2) \u22124.",
    ].entries()) {
      expect(containsAnswerLeak(r17LeakText, "-4")).toBe(true);
      const r17MissRejected = issueOfflineFlashcardLease({
        leaseId: `lease-r17-miss-leak-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: "-4",
            freshVariantStem: r17LeakText,
          }),
        ],
      });
      expect(r17MissRejected.ok).toBe(false);
      if (!r17MissRejected.ok) {
        expect(r17MissRejected.httpStatus).toBe(422);
        expect(r17MissRejected.code).toBe("miss_variant_answer_leak");
      }

      const r17PromptRejected = issueOfflineFlashcardLease({
        leaseId: `lease-r17-prompt-leak-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: "-4",
            freshVariantStem: "Compute the steady-state offset for the spring system.",
          }),
          {
            ...makeFlashcardCandidate(400 + idx),
            prompt: r17LeakText,
            backSummary: "Recall the kinematic sign convention.",
          },
        ],
      });
      expect(r17PromptRejected.ok).toBe(false);
      if (!r17PromptRejected.ok) {
        expect(r17PromptRejected.httpStatus).toBe(422);
        expect(r17PromptRejected.code).toBe("miss_variant_answer_leak");
      }
    }

    for (const [idx, r17BenignStem] of [
      "$(x) \u2212 4$",
      "(x + 1) \u2212 4",
      "(a/b) \u2212 4",
      "Evaluate (a/b) \u2212 4",
      "f(x) \u2212 4",
      "sqrt(2) \u2212 4",
      "min(x) \u2212 4",
      "Solve (a) \u2212 4 = 0",
      "Solve Velocity (m/s): (v/t) \u2212 4 = 0",
      "Solve a \u2212 4*\u03B6 = 0, where \u03B6 = 1\u22122.",
    ].entries()) {
      expect(containsAnswerLeak(r17BenignStem, "-4")).toBe(false);
      const r17Allowed = issueOfflineFlashcardLease({
        leaseId: `lease-r17-benign-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: "-4",
            freshVariantStem: r17BenignStem,
          }),
        ],
      });
      expect(r17Allowed.ok).toBe(true);
    }

    // [Round-18 P1-1/P1-2/P1-3] Unified priority for closing groups outside math delimiters:
    // (A) Prose/option labels (English, CJK, Unicode) veto unconditionally even with trailing `≈`/`≡`/`=`,
    // (B) Case-sensitive physical/SI units reject unless led by an explicit math directive (English/CJK),
    //     math operator, or explicit variable bindings (`m = ..., s = ...`),
    // (C) Genuine math directives (`Evaluate (m/s) − 4, where m = 6 and s = 2.`, `计算 (m/s) − 4，其中 m = 6, s = 2。`,
    //     `y = (m/s) − 4, where m = 8 and s = 2.`) remain allowed!
    for (const [idx, r18LeakText] of [
      "Velocity change (m/s) \u22124 \u2248 \u22123.99.",
      "Option (a) \u22124 \u2261 1 (mod 5).",
      "比值 (a/b) \u22124。",
      "比值(a/b) \u22124。",
      "速度变化 (m/s) \u22124 \u2248 \u22123.99。",
      "选项 (a) \u22124 \u2261 1 (mod 5)。",
      "(m/s) \u22124.",
      "(m/s) \u22124 \u2248 \u22123.99.",
      "(V/m) \u22124.",
      "(J/K) \u22124.",
    ].entries()) {
      expect(containsAnswerLeak(r18LeakText, "-4")).toBe(true);
      const r18MissRejected = issueOfflineFlashcardLease({
        leaseId: `lease-r18-miss-leak-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: "-4",
            freshVariantStem: r18LeakText,
          }),
        ],
      });
      expect(r18MissRejected.ok).toBe(false);
      if (!r18MissRejected.ok) {
        expect(r18MissRejected.httpStatus).toBe(422);
        expect(r18MissRejected.code).toBe("miss_variant_answer_leak");
      }

      const r18PromptRejected = issueOfflineFlashcardLease({
        leaseId: `lease-r18-prompt-leak-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: "-4",
            freshVariantStem: "Determine the equilibrium displacement for the damped oscillator.",
          }),
          {
            ...makeFlashcardCandidate(500 + idx),
            prompt: r18LeakText,
            backSummary: "Check sign and modular equivalence rules.",
          },
        ],
      });
      expect(r18PromptRejected.ok).toBe(false);
      if (!r18PromptRejected.ok) {
        expect(r18PromptRejected.httpStatus).toBe(422);
        expect(r18PromptRejected.code).toBe("miss_variant_answer_leak");
      }
    }

    for (const [idx, r18BenignStem] of [
      "Evaluate (m/s) \u2212 4, where m = 6 and s = 2.",
      "计算 (m/s) \u2212 4，其中 m = 6, s = 2。",
      "y = (m/s) \u2212 4, where m = 8 and s = 2.",
      "(m/s) \u2212 4, where m = 6 and s = 2.",
      "(n/m^2) \u2212 4",
      "(a/c) \u2212 4",
      "$(x) \u2212 4$",
      "(x + 1) \u2212 4",
      "(a/b) \u2212 4",
      "Evaluate (a/b) \u2212 4",
      "f(x) \u2212 4",
      "sqrt(2) \u2212 4",
      "Solve (a) \u2212 4 = 0",
      "Solve Velocity (m/s): (v/t) \u2212 4 = 0",
      "Solve a \u2212 4*\u03B6 = 0, where \u03B6 = 1\u22122.",
    ].entries()) {
      expect(containsAnswerLeak(r18BenignStem, "-4")).toBe(false);
      const r18Allowed = issueOfflineFlashcardLease({
        leaseId: `lease-r18-benign-${idx}`,
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [
          makeMissVariantCandidate({
            answerKey: "-4",
            freshVariantStem: r18BenignStem,
          }),
        ],
      });
      expect(r18Allowed.ok).toBe(true);
    }

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

  it.each([
    "题解 (m/s) −4。",
    "注解 [m/s] - 4。",
    "正解 (a) −4 = 0。",
    "要求（m/s）− 4。",
    "建设 (m/s) −4。",
    "口令 (m/s) −4。",
    "杜若 (m/s) −4。",
    "便当 (m/s) −4。",
    "This label says evaluate (m/s) −4.",
    "Compute velocity change (m/s) −4.",
    "First compute velocity change (m/s) −4.",
    "Please first compute velocity change (m/s) −4.",
    "Step 2 then calculate the speed (km/h) −4.",
    "先计算速度 (m/s) −4。",
    "Calculate speed (km/h) −4.",
    "Answer (m/s) −4, where m = 6 and s = 2.",
    "1(a) Let m = 6 and s = 2, 2(b) Speed change: (m/s) −4.",
    "1(a) 设 m = 6，s = 2，2(b)速度变化：(m/s) −4。",
    "1(a) Speed change: (m/s) −4 2(b) Let m = 6 and s = 2.",
    "Let m = 6 and s = 2, (b) Speed change: (m/s) −4.",
    "Speed change: (m/s) −4, (b) let m = 6 and s = 2.",
    "Speed change: (m/s) −4 (b) m = 6 and s = 2.",
    "Speed change: (m/s) −4 (b): m = 6 and s = 2.",
    "Speed change: (m/s) −4 (b):m = 6 and s = 2.",
    "Ｓｐｅｅｄ change： （ｍ／ｓ） −４ （b）：ｍ = ６ and ｓ = ２.",
    "Speed change: (m/s) −4 (b).m = 6 and s = 2.",
    "Speed change: (m/s) −4 (b);m = 6 and s = 2.",
    "Speed change: (m/s) −4 b):m = 6 and s = 2.",
    "Speed change: (m/s) −4 b)m = 6 and s = 2.",
    "Speed change: (m/s) −4 [b]:m = 6 and s = 2.",
    "Speed change: (m/s) −4 2.m = 6 and s = 2.",
    "Speed change: (m/s) −4 2(b)—m = 6 and s = 2.",
    "Speed change: (m/s) −4 (b)： m = 6 and s = 2.",
    "Speed change: (m/s) −4 (b). m = 6 and s = 2.",
    "Speed change: (m/s) −4 (b); m = 6 and s = 2.",
    "Speed change: (m/s) −4 (b), m = 6 and s = 2.",
    "Speed change: (m/s) −4 (b) - m = 6 and s = 2.",
    "Speed change: (m/s) −4 (b) — m = 6 and s = 2.",
    "Speed change: (m/s) −4 2(b)– m = 6 and s = 2.",
    "Speed change: (m/s) −4 (i) m := 6, m = 6 and s = 2.",
    "Speed change: (m/s) −4 (ii) $m = 6$ and s = 2.",
    "Let m = 6 and s = 2 (b) speed change: (m/s) −4.",
    "Speed change: (m/s) −4, Exercise 2 Let m = 6 and s = 2.",
    "(m/s) −4. In the next exercise, m = 6 and s = 2.",
    "Speed change: (m/s) −4 approx. In the next exercise, m = 6 and s = 2.",
    "Speed change: (m/s) −4 approx. m = 6 and s = 2.",
    "Speed change: (m/s) −4 approx. 2) m = 6 and s = 2.",
    "Speed change: (m/s) −4 approx. 2(b) Let m = 6 and s = 2.",
    "Speed change: (m/s) −4 approx. 5, m = 6 and s = 2.",
    "(m/s) −4, approx.2(b) m = 6 and s = 2.",
    "(m/s) −4, approx. 2 [b] m = 6 and s = 2.",
    "(m/s) −4, e.g. 2a) m = 6 and s = 2.",
    "(m/s) −4, i.e.(b) m = 6 and s = 2.",
    "(m/s) −4, cf. [2] m = 6 and s = 2.",
    "Speed change: (m/s) −4, e.g. In the next exercise, m = 6 and s = 2.",
    "(m/s) −4, i.e. 下一题中，m = 6，s = 2。",
    "(m/s) −4, cf. Then m = 6 and s = 2.",
    "(m/s) −4, vs. 2) m = 6 and s = 2.",
    "(m/s) −4, viz. (2) m = 6 and s = 2.",
    "(m/s) −4, etc. m = 6 and s = 2.",
    "(m/s) − 4？ 下一题中，m = 6, s = 2。",
    "[m/s] - 4; in the next exercise, m = 6 and s = 2.",
    "(m/s) −4\nIn the next exercise, m = 6 and s = 2.",
    "(m/s) - 4\r\nm = 6 and s = 2.",
    "(m/s)\n- 4, where m = 6 and s = 2.",
    "(m/s) -\n4, where m = 6 and s = 2.",
    "(m/s) −\n4, where m = 6 and s = 2.",
    "m = 6. (m/s) −4, where s = 2.",
    "(m/s) −4, where m => 6 and s => 2.",
    "(l/s) −4.",
    "(g/l) −4 ≈ −3.99.",
    "(mol/l) −4。",
    "([l/s]) −4。",
    "(ml) −4.",
    "(mg/dl) −4.",
    "(kl/s) −4.",
    "(µl/s) −4.",
    "(ul/s) −4.",
  ])("rejects a signed answer in %j", freshVariantStem => {
    expect(issueOfflineFlashcardLease({
      leaseId: "lease-signed-prose",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [makeMissVariantCandidate({ answerKey: "-4", freshVariantStem })],
    })).toMatchObject({ ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
  });

  it("rejects a signed answer before a compact sub-item on a sibling card back", () => {
    expect(issueOfflineFlashcardLease({
      leaseId: "lease-signed-compact-sibling",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [
        makeMissVariantCandidate({ answerKey: "-4" }),
        {
          ...makeFlashcardCandidate(900),
          backSummary: "Speed change: (m/s) −4 (b):m = 6 and s = 2.",
        },
      ],
    })).toMatchObject({ ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
  });

  it.each([
    "First evaluate (m/s) − 4, where m = 6 and s = 2.",
    "Please first evaluate (m/s) − 4.",
    "Then please also determine the expression [m/s] − 4.",
    "Now please simplify the expression (m/s) − 4.",
    "Evaluate (m/s) − 4, e.g., m = 6 and s = 2.",
    "Step 2 then determine the value of [m/s] − 4.",
    "(b) First evaluate (m/s) − 4.",
    "先计算 (m/s) − 4，其中 m = 6，s = 2。",
    "请先计算 (m/s) − 4。",
    "请先再计算表达式 (m/s) − 4。",
    "第十二步 然后请计算表达式 (m/s) − 4。",
    "Evaluate the expression (m/s) − 4, where m = 6 and s = 2.",
    "Find the value of (m/s) −4 when m = 6 and s = 2.",
    "Evaluate the value of [l/s] - 4, where l = 8 and s = 2.",
    "Example: Please simplify the following algebraic expression （m/s）− 4.",
    "计算表达式 (m/s) − 4，其中 m = 6, s = 2。",
    "求代数式 (a/b) − 4 的值",
    "例：解方程 (m/s) −4 = 0。",
    "若 (m/s) −4 = 0，则求 m。",
    "求函数 (m/s) −4 的值。",
    "Evaluate (l/s) − 4, where l = 6 and s = 2.",
    "Evaluate (μl/s) − 4.",
    "(m/s) −4, where m = 6.5 and s = .2.",
    "1(a) Let m = 6 and s = 2, (m/s) −4.",
    "1(a) Previous question, 2(b) (m/s) −4, where m = 6 and s = (2).",
    "(m/s) −4, where m = 2(x) and s = 3.",
    "(m/s) −4, where m = 2(b) = 8 and s = 2.",
    "(m/s) −4, where m = (a) + (b) and s = 2.",
    "(m/s) −4, where m = 2(b), s = 2.",
    "(m/s) −4, where m = (a) + (b), s = 2.",
    "(m/s) −4, where m = (a)(b), s = 2.",
    "(m/s) −4, where m = f(x, b), and s = 2.",
    "(m/s) −4, where m = approx. +.6 and s = 2.",
    "(m/s) −4, where m = approx. 5.2 and s = 2.",
    "(m/s) −4, e.g. m = 6 and s = 2.",
    "(m/s) −4, i.e., m = 6 and s = 2.",
    "(V/m) −4, cf. V = 6 and m = 2.",
    "(m/s) − 4, where, e.g., m = 6 and s = 2.",
    "(m/s) −4，其中m = 6，s = 2。",
  ])("allows algebraic subtraction in %j", freshVariantStem => {
    expect(issueOfflineFlashcardLease({
      leaseId: "lease-signed-algebra",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [makeMissVariantCandidate({ answerKey: "-4", freshVariantStem })],
    })).toMatchObject({ ok: true });
  });

  it.each([
    ["variant stem", '["B","D"]'],
    ["variant stem", '[ "B", "D" ]'],
    ["variant stem", "B, D"],
    ["variant stem", '"B, D"'],
    ["variant stem", "'B , D'"],
    ["variant stem", "[B, D]"],
    ["variant stem", '"B", "D"'],
    ["variant stem", "' B ', ' D '"],
    ["variant stem", "“B”， “D”"],
    ["variant stem", "「 B 」 、 「 D 」"],
    ["variant stem", "[ B ], ( D )"],
    ["variant stem", "«B», «D»"],
    ["variant stem", "‹B›, ‹D›"],
    ["variant stem", "《B》，〈D〉"],
    ["sibling card", '["B","D"]'],
    ["sibling card", '["B", "D"]'],
    ["sibling card", "B , D"],
    ["sibling card", '"B , D"'],
    ["sibling card", "'B, D'"],
    ["sibling card", "[B, D]"],
    ["sibling card", '"B", "D"'],
    ["sibling card", "`B`, `D`"],
    ["sibling card", "‘B’、‘D’"],
    ["sibling card", "B、D"],
    ["sibling card", 'B , " D "'],
    ["sibling card", "«B», «D»"],
    ["sibling card", "<B>, <D>"],
    ["sibling card", "『 B 』、『 D 』"],
  ] as const)("rejects a sealed array in a %s (%s)", (surface, sequence) => {
    const leakedText = `Use the sequence ${sequence}.`;
    const variant = makeMissVariantCandidate({
      sealedPayload: { order: ["B", "D"] },
      freshVariantStem: surface === "variant stem" ? leakedText : "Which ordering is correct?",
    });
    const candidates = surface === "variant stem" ? [variant] : [
      variant,
      { ...makeFlashcardCandidate(900), prompt: "Recall the order.", backSummary: leakedText },
    ];
    expect(issueOfflineFlashcardLease({
      leaseId: "lease-array-reveal",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates,
    })).toMatchObject({ ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
  });

  it.each(['["D", "B"]', '"AB , D"', '"B, Delta"', '"D", "B"', '"Bad", "Dog"'])(
    "allows a different sequence in a stem (%s)",
    sequence => {
      expect(issueOfflineFlashcardLease({
        leaseId: "lease-array-decoy",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [makeMissVariantCandidate({
          freshVariantStem: `Compare the sequence ${sequence} with your result.`,
          sealedPayload: { order: ["B", "D"] },
        })],
      })).toMatchObject({ ok: true });
    },
  );

  it.each([
    ["variant stem", "Compare [D], [B]"],
    ["variant stem", "Compare D, [B]"],
    ["variant stem", "Compare D, B"],
    ["sibling card", "Compare [D], [B]"],
    ["sibling card", 'Compare "D" and "B"'],
    ["sibling card", 'Compare «D» and [B]'],
  ] as const)("allows a reversed sequence at the end of a %s (%s)", (surface, text) => {
    const variant = makeMissVariantCandidate({
      sealedPayload: { order: ["B", "D"] },
      freshVariantStem: surface === "variant stem" ? text : "Which ordering is correct?",
    });
    const candidates = surface === "variant stem" ? [variant] : [
      variant,
      { ...makeFlashcardCandidate(900), backSummary: text },
    ];
    expect(issueOfflineFlashcardLease({
      leaseId: "lease-array-terminal-decoy",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates,
    })).toMatchObject({ ok: true });
  });

  describe.each(["variant stem", "sibling card back"] as const)("option sequence connectors in a %s", surface => {
    const separators = [
      ", ", "，", "、", "; ", "/", " & ", " + ", " -> ", "→", " => ",
      " and ", " or ", " then ", ", and ", ", then ", " ＡＮＤ ",
    ];

    it.each([
      ...separators.flatMap(separator => [
        { text: `Use the sequence [B]${separator}[D]`, ok: false },
        { text: `Compare [D]${separator}[B]`, ok: true },
      ]),
      { text: "[B], and [D]", ok: false },
      { text: "[B] then [D]", ok: false },
      { text: "Use «B» and «D»", ok: false },
      { text: "B and D", ok: false },
      { text: "Compare «D» and «B»", ok: true },
      { text: "The marked response [B]", ok: false },
      { text: "The marked response [D]", ok: false },
    ])("sets ok=$ok for $text", ({ text, ok }) => {
      const variant = makeMissVariantCandidate({
        sealedPayload: { order: ["B", "D"] },
        freshVariantStem: surface === "variant stem" ? text : "Which ordering is correct?",
      });
      const candidates = surface === "variant stem" ? [variant] : [
        variant,
        { ...makeFlashcardCandidate(900), backSummary: text },
      ];
      expect(issueOfflineFlashcardLease({
        leaseId: "lease-option-connectors",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates,
      })).toMatchObject(ok ? { ok: true } : { ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
    });
  });

  describe.each(["variant stem", "sibling card back"] as const)("Unicode answer checks in a %s", surface => {
    it.each([
      { secret: { sealedPayload: { order: ["Ｂ", "Ｄ"] } }, text: "Use B and D" },
      { secret: { sealedPayload: { order: ["Ｂ", "Ｄ"] } }, text: "Use ［Ｂ］ and ［Ｄ］" },
      { secret: { sealedPayload: { order: ["⒝", "Ⓓ"] } }, text: "Use «B» and «D»" },
      { secret: { sealedPayload: { order: ["\u200B Ｂ", "Ｄ\u2060 "] } }, text: "Use [B] and [D]" },
      { secret: { sealedPayload: { order: ["Ｂ Ｘ", "Ｄ Ｙ"] } }, text: "Use B X and D Y" },
      { secret: { answerKey: "B" }, text: "The marked response [Ｂ]" },
      { secret: { answerKey: "B" }, text: "The marked response ［Ｂ］" },
      { secret: { answerKey: "Ｂ" }, text: "Correct option is Ｂ." },
      { secret: { answerKey: "Ｂ\u200B" }, text: "Correct option is ［Ｂ\u2060］." },
      { secret: { answerKey: "B" }, text: "Ｃｏｒｒｅｃｔ ｏｐｔｉｏｎ ｉｓ B." },
      { secret: { answerKey: "42" }, text: "The reading is ４\u034F２." },
      { secret: {}, text: "Ｓｏｌｕｔｉｏｎ： Show the derivation." },
    ])("rejects $text", ({ secret, text }) => {
      const variant = makeMissVariantCandidate({
        ...secret,
        freshVariantStem: surface === "variant stem" ? text : "Which ordering is correct?",
      });
      const candidates = surface === "variant stem" ? [variant] : [
        variant,
        { ...makeFlashcardCandidate(900), backSummary: text },
      ];
      expect(issueOfflineFlashcardLease({
        leaseId: "lease-unicode-answer",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates,
      })).toMatchObject({ ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
    });

    it("allows a reversed full-width sequence", () => {
      const text = "Compare ［Ｄ］ and ［Ｂ］";
      const variant = makeMissVariantCandidate({
        sealedPayload: { order: ["Ｂ", "Ｄ"] },
        freshVariantStem: surface === "variant stem" ? text : "Which ordering is correct?",
      });
      const candidates = surface === "variant stem" ? [variant] : [
        variant,
        { ...makeFlashcardCandidate(900), backSummary: text },
      ];
      expect(issueOfflineFlashcardLease({
        leaseId: "lease-unicode-answer-decoy",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates,
      })).toMatchObject({ ok: true });
    });
  });

  describe.each(["variant stem", "sibling card back"] as const)("single-choice wrappers in a %s", surface => {
    const wrappedLabels = [
      "«B»", "‹B›", "「B」", "『B』", "“B”", "‘B’", "《B》", "〈B〉", "<B>", "{B}", "[B]", "(B)",
      '"B"', "'B'", "`B`",
    ];

    it.each([
      ...wrappedLabels.flatMap(label => [
        { text: `Correct option is ${label} for this exercise.`, answerKey: "B", ok: false },
        { text: `The marked response ${label}`, answerKey: "B", ok: false },
      ]),
      { text: "Correct option is «Ｂ»", answerKey: "B", ok: false },
      { text: "Correct option is «B»", answerKey: "B", ok: false },
      { text: "Answer: 「B」", answerKey: "B", ok: false },
      { text: "Marked response = ‹B› for this exercise.", answerKey: "B", ok: false },
      { text: "The marked response «B».", answerKey: "B", ok: false },
      { text: "The marked response [B]!", answerKey: "B", ok: false },
      { text: "The marked response (B)?", answerKey: "B", ok: false },
      { text: "The marked response «B»。", answerKey: "B", ok: false },
      { text: "The marked response «B.!»。 ", answerKey: "B", ok: false },
      { text: 'The marked response "B".', answerKey: "B", ok: false },
      { text: 'The marked response "B."', answerKey: "B", ok: false },
      { text: "The marked response «B». Show your work.", answerKey: "B", ok: false },
      { text: "The marked response [B]! Explain why.", answerKey: "B", ok: false },
      { text: "See «B»; justify each step.", answerKey: "B", ok: false },
      { text: 'The marked response "B." Show your work.', answerKey: "B", ok: false },
      { text: 'The marked response "B." And I will explain.', answerKey: "B", ok: false },
      { text: "See «B»; I will justify each step.", answerKey: "B", ok: false },
      { text: "The marked response [\nB].", answerKey: "B", ok: false },
      { text: "The marked response [\r\nB]. Show your work.", answerKey: "B", ok: false },
      { text: "See «B»; I’ll justify each step.", answerKey: "B", ok: false },
      { text: "See [B]; I'll explain.", answerKey: "B", ok: false },
      { text: "See [B]; ‹I›ll explain.", answerKey: "B", ok: false },
      { text: "Compare D», [B]. Show your work.", answerKey: "B", ok: false },
      { text: "The marked response <B.> Show your work.", answerKey: "B", ok: false },
      { text: "The marked response [\\,B].", answerKey: "B", ok: false },
      { text: "The marked response [\\quad \\mathrm{B}].", answerKey: "B", ok: false },
      { text: "The marked response <\\text{\\mathbf{B}}.> Show your work.", answerKey: "B", ok: false },
      { text: "The marked response [$\\mathbf{B}$].", answerKey: "B", ok: false },
      { text: "Correct option is «$\\mathrm{B}$».", answerKey: "B", ok: false },
      { text: "The marked response [$$B$$].", answerKey: "B", ok: false },
      { text: "The marked response [\\(B\\)].", answerKey: "B", ok: false },
      { text: "The marked response (\\[B\\]).", answerKey: "B", ok: false },
      { text: "The marked response <**$B$**.> Show your work.", answerKey: "B", ok: false },
      { text: "The marked response «*B*».", answerKey: "B", ok: false },
      { text: "The marked response (_B_).", answerKey: "B", ok: false },
      { text: "The marked response [`B`].", answerKey: "B", ok: false },
      { text: "The marked response [___B___].", answerKey: "B", ok: false },
      { text: "The marked response [***B***].", answerKey: "B", ok: false },
      { text: "The marked response [*****B*****].", answerKey: "B", ok: false },
      { text: "The marked response [**_B_**].", answerKey: "B", ok: false },
      { text: "The marked response [*__B__*].", answerKey: "B", ok: false },
      { text: "The marked response [~~B~~].", answerKey: "B", ok: false },
      { text: "The marked response [**`B`**].", answerKey: "B", ok: false },
      { text: "The marked response [`` `B` ``].", answerKey: "B", ok: false },
      { text: "The marked response ```B```.", answerKey: "B", ok: false },
      { text: "Review item_b and x_1.", answerKey: "B", ok: true },
      { text: "A ticket costs $5. The marked response [$B$].", answerKey: "B", ok: false },
      { text: "A ticket costs $5. The marked response [$ B $].", answerKey: "B", ok: false },
      { text: "A ticket costs $5 or $10.", answerKey: "B", ok: true },
      { text: "The marked response (B)\r\nShow your work.", answerKey: "B", ok: false },
      { text: "标记结果 «B»。解释理由。", answerKey: "B", ok: false },
      { text: "Compare «D»,\n«B». Show your work.", answerKey: "B", ok: false },
      { text: "Compare «D» and «B». Then see «B». Explain both.", answerKey: "B", ok: false },
      { text: "Correct option is B.", answerKey: "B", ok: false },
      { text: "Use the sequence «B.» and «D.»", answerKey: "B", ok: false },
      { text: "Use the sequence [$B$] and [_D_].", answerKey: "B", ok: false },
      { text: "Compare «D» and «B»", answerKey: "B", ok: true },
      { text: "Compare «D» and «B».", answerKey: "B", ok: true },
      { text: "Compare [D], [B].", answerKey: "B", ok: true },
      { text: "Compare «D» and «B.»", answerKey: "B", ok: true },
      { text: 'Compare "D." and "B."!', answerKey: "B", ok: true },
      { text: "Compare «D» and «B». Show your work.", answerKey: "B", ok: true },
      { text: "Compare <D> and <B>. Show your work.", answerKey: "B", ok: true },
      { text: "Compare <**$D$**> and <**$B$**>. Show your work.", answerKey: "B", ok: true },
      { text: "Compare <D> and <\nB>. Show your work.", answerKey: "B", ok: true },
      { text: "Compare [D], [B]. Explain both.", answerKey: "B", ok: true },
      { text: "Compare [D]; [B]. Explain both.", answerKey: "B", ok: true },
      { text: "Compare «D.» and «B.» Explain both.", answerKey: "B", ok: true },
      { text: "A cat runs across the garden.", answerKey: "A", ok: true },
      { text: "I am learning about option order.", answerKey: "I", ok: true },
      { text: "The sentence ends in a.", answerKey: "A", ok: true },
      { text: "This is plan a. Show your work.", answerKey: "A", ok: true },
      { text: "Her middle initial is B.", answerKey: "B", ok: true },
      { text: "Explain why «B» differs from the examples.", answerKey: "B", ok: true },
    ])("sets ok=$ok for $text", ({ text, answerKey, ok }) => {
      const variant = makeMissVariantCandidate({
        answerKey,
        sealedPayload: { order: ["B", "D"] },
        freshVariantStem: surface === "variant stem" ? text : "Which ordering is correct?",
      });
      const candidates = surface === "variant stem" ? [variant] : [
        variant,
        { ...makeFlashcardCandidate(900), backSummary: text },
      ];
      expect(issueOfflineFlashcardLease({
        leaseId: "lease-choice-wrappers",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates,
      })).toMatchObject(ok ? { ok: true } : { ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
    });
  });

  it.each([
    "The marked response [B]",
    "Compare the candidates, [B]",
    "Compare [D], [B]. Correct option is B",
    "Compare [D], [B]. The answer = B",
  ])("still detects a single-choice reveal in %j", stem => {
    expect(containsAnswerLeak(stem, "B")).toBe(true);
  });

  describe.each(["variant stem", "sibling card back"] as const)("canonical math options in a %s", surface => {
    const formattedOrder = ["\\mathbf{π}", "\\mathrm{θ}"];
    it.each([
      { secret: { answerKey: '["π","θ"]' }, text: "Use pi and theta.", ok: false },
      { secret: { answerKey: '["π","θ"]' }, text: "Compare theta and pi.", ok: true },
      {
        secret: { answerKey: JSON.stringify(["\\mathbf{π}", "\\mathrm{θ}"]) },
        text: "Use pi and theta.",
        ok: false,
      },
      { secret: { sealedPayload: { order: ["π", "θ"] } }, text: "Use pi and theta.", ok: false },
      { secret: { sealedPayload: { order: ["π", "θ"] } }, text: "Compare theta and pi.", ok: true },
      {
        secret: { sealedPayload: { order: ["π", "θ"] } },
        text: "Consider both. Compare «theta» and «pi». Explain.",
        ok: true,
      },
      {
        secret: { sealedPayload: { order: ["π", "θ"] } },
        text: "The selected order is theta and pi.",
        ok: false,
      },
      {
        secret: { sealedPayload: { order: ["π", "θ"] } },
        text: "Compare theta and pi. The selected value is pi.",
        ok: false,
      },
      {
        secret: { answerKey: "π", sealedPayload: { order: ["π", "θ"] } },
        text: "Compare theta and pi.",
        ok: false,
      },
      {
        secret: { sealedPayload: { order: ["B", "D"] } },
        text: "Correct option is D and B.",
        ok: false,
      },
      ...[{ answerKey: "97", sealedPayload: { order: formattedOrder } }, { answerKey: JSON.stringify(formattedOrder) }]
        .flatMap(secret => [
          { secret, text: "The selected value is pi.", ok: false },
          { secret, text: "The marked response [pi].", ok: false },
          { secret, text: "The marked response [_pi_].", ok: false },
          { secret, text: "The marked response [___pi___].", ok: false },
          { secret, text: "_pi_", ok: false },
          { secret, text: "**pi**", ok: false },
          { secret, text: "`pi`", ok: false },
          { secret, text: "$\\pi$", ok: false },
          { secret, text: "Compute alpha_pi + 1.", ok: true },
          { secret, text: "Find the topic associated with pi_1.", ok: true },
          { secret, text: "Compare _theta_ and _pi_.", ok: true },
          { secret, text: "Compare theta and pi.", ok: true },
          { secret, text: "Compare \\mathrm{θ} and \\mathbf{π}.", ok: true },
          { secret, text: "Compare theta and pi. The selected value is _theta_.", ok: false },
        ]),
      { secret: { sealedPayload: { order: ["\\mathbf{red}", "blue"] } }, text: "The marked response [_red_].", ok: false },
      { secret: { answerKey: JSON.stringify(["\\mathrm{π}"]) }, text: "The marked response [_pi_].", ok: false },
    ])("sets ok=$ok for $text ($secret)", ({ secret, text, ok }) => {
      const variant = makeMissVariantCandidate({
        ...secret,
        freshVariantStem: surface === "variant stem" ? text : "Which ordering is correct?",
      });
      const candidates = surface === "variant stem" ? [variant] : [
        variant,
        { ...makeFlashcardCandidate(900), backSummary: text },
      ];
      expect(issueOfflineFlashcardLease({
        leaseId: "lease-canonical-option-text",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates,
      })).toMatchObject(ok ? { ok: true } : { ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
    });
  });

  describe.each(["variant stem", "sibling card back"] as const)("formatted scalars and decoded answers in a %s", surface => {
    const greekCommands = ["\\mathbf{\\pi}", "\\mathrm{\\theta}"];
    const scalarOnly = { canonicalSolution: undefined, gradingRubric: undefined, referenceAnswer: undefined, sealedPayload: {} };
    const overDecodeLimit = Array.from({ length: 8 }).reduce<string>(
      body => JSON.stringify({ nested: body }),
      "[17,42]",
    );

    it.each([
      ...["B", "**B**", "___B___", "$B$", "[*$ B $*]", "\\mathbf{B}", "The marked response [*$ B $*]."]
        .map(text => ({ secret: { answerKey: "B" }, text, ok: false })),
      ...["A ticket costs $5. ", "Prices are $5 and $10. ", "A ticket costs $12.50. ", "A ticket costs $1,000. "]
        .flatMap(prefix => ["The marked response [*$ B $*].", "[$ B $]", "[$B$]", "$B$", "**$B$**"]
          .map(text => ({ secret: { answerKey: "B" }, text: prefix + text, ok: false }))),
      { secret: { answerKey: "B" }, text: "Prices are $5 and $10. Review item_b.", ok: true },
      { secret: { answerKey: "B" }, text: "A ticket costs $5 [*$ B $*].", ok: false },
      { secret: { answerKey: "42" }, text: "The marked response [___42___].", ok: false },
      { secret: { answerKey: "42" }, text: "$42$", ok: false },
      { secret: { answerKey: "\\mathbf{B}" }, text: "The marked response [B].", ok: false },
      ...["\\pi", "π", "pi"].flatMap(answerKey =>
        ["$\\pi$", "π", "pi", "A ticket costs $5. The marked response [_$\\pi$_]."]
          .map(text => ({ secret: { answerKey }, text, ok: false }))),
      ...["\\theta", "θ", "theta", "\\vartheta"].flatMap(answerKey =>
        ["$\\theta$", "ϑ", "theta"].map(text => ({ secret: { answerKey }, text, ok: false }))),
      ...[
        ["\\Gamma", "Γ"], ["\\varepsilon", "ϵ"], ["\\varpi", "ϖ"], ["\\varrho", "ϱ"],
        ["\\varsigma", "ς"], ["\\varphi", "ϕ"],
      ].map(([answerKey, label]) => ({ secret: { answerKey }, text: `The marked response [${label}].`, ok: false })),
      ...[
        { answerKey: JSON.stringify(greekCommands) },
        { sealedPayload: { order: greekCommands } },
        { sealedPayload: { order: JSON.stringify(greekCommands) } },
        { sealedPayload: { order: ["π", "θ"] } },
      ].flatMap(secret => [
        { secret, text: "The selected value is π.", ok: false },
        { secret, text: "Use pi and theta.", ok: false },
        { secret, text: "Use $\\pi$ and $\\theta$.", ok: false },
        { secret, text: "Compare $\\theta$ and $\\pi$.", ok: true },
        { secret, text: "Compare $\\theta$ and $\\pi$. The selected value is [___pi___].", ok: false },
        { secret, text: "Compute alpha_pi + pi_1.", ok: true },
      ]),
      ...[
        { answerKey: "[17,42]" },
        { sealedPayload: { order: "[17,42]" } },
        { sealedPayload: { order: [17, 42] } },
        { sealedPayload: ['{"nested":"[17,42]"}'] },
        { answerKey: JSON.stringify(JSON.stringify([17, 42])) },
      ].flatMap(secret => [
        { secret, text: "The selected value is 42.", ok: false },
        { secret, text: "Use 17 and 42.", ok: false },
        { secret, text: "Use the variable n42 and the index 170.", ok: true },
      ]),
      { secret: { answerKey: '[true,"red",42]' }, text: "The selected value is true.", ok: false },
      { secret: { sealedPayload: { order: '{"nested":"[false,97]"}' } }, text: "The selected value is false.", ok: false },
      { secret: { sealedPayload: { order: overDecodeLimit } }, text: "Review the ordering.", ok: false },
    ])("sets ok=$ok for $text with $secret", ({ secret, text, ok }) => {
      const variant = makeMissVariantCandidate({
        ...scalarOnly,
        answerKey: undefined,
        ...secret,
        freshVariantStem: surface === "variant stem" ? text : "Which ordering is correct?",
      });
      const candidates = surface === "variant stem" ? [variant] : [
        variant,
        { ...makeFlashcardCandidate(900), backSummary: text },
      ];
      expect(issueOfflineFlashcardLease({
        leaseId: "lease-formatted-scalar-and-decoded-answer",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates,
      })).toMatchObject(ok ? { ok: true } : { ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
    });
  });

  it.each([
    { answerKey: "[17,0.50]", text: "Use 17 and 0.50.", leaks: true },
    { answerKey: "[1e3,9007199254740993]", text: "Use 1000 and 9007199254740993.", leaks: true },
    { answerKey: "[1e3,9007199254740993]", text: "Use 9007199254740993 and 1000.", leaks: false },
    { answerKey: JSON.stringify([JSON.stringify("red"), 42]), text: "Use red and 42.", leaks: true },
    { answerKey: "[17,null]", text: "Use 17 and null.", leaks: true },
  ])("checks the decoded sequence $answerKey in $text", ({ answerKey, text, leaks }) => {
    expect(containsAnswerLeak(text, answerKey)).toBe(leaks);
  });

  describe.each(["variant stem", "backSummary", "prompt"] as const)("formatted choices and JSON literals in a %s", surface => {
    const encodedRed = JSON.stringify("red");
    const encodedLambda = JSON.stringify("λ");
    it.each([
      ...["**B**", "___B___", "~~B~~", "\\(B\\)", "\\[B\\]", "\\mathbf{B}", "\\textbf{B}", "\\mathrm{B}", "[**\\mathbf{B}**]"]
        .map(choice => ({ secret: { answerKey: "B" }, text: `The marked response ${choice}.`, ok: false })),
      { secret: { answerKey: "A" }, text: "This is *a* book.", ok: true },
      { secret: { answerKey: "B" }, text: "Read **B** before moving on.", ok: true },
      ...["$.50", "$ 5", "$ .50", "$1,250.50"].flatMap(amount => [
        { secret: { answerKey: "B" }, text: `A ticket costs ${amount}. The marked response [*$ B $*].`, ok: false },
        { secret: { answerKey: "B" }, text: `A ticket costs ${amount}. Read the instructions.`, ok: true },
      ]),
      ...[
        { sealedPayload: { order: [encodedRed, 42] } },
        { answerKey: JSON.stringify([encodedRed, 42]) },
        { sealedPayload: { order: [JSON.stringify(encodedRed), 42] } },
      ].flatMap(secret => [
        { secret, text: "The selected value is red.", ok: false },
        { secret, text: "Use red and 42.", ok: false },
        { secret, text: "Read the redwood example.", ok: true },
      ]),
      { secret: { sealedPayload: { order: [encodedLambda, JSON.stringify("θ")] } }, text: "Compare theta and lambda.", ok: true },
      { secret: { answerKey: "[17,0.50]" }, text: "The selected value is 0.50.", ok: false },
      { secret: { answerKey: "[17,0.50]" }, text: "The selected value is 0.5.", ok: false },
      { secret: { answerKey: "[17,0.50]" }, text: "Use 17 and 0.50.", ok: false },
      { secret: { answerKey: "[17,0.50]" }, text: "Compare 170 with 0.501.", ok: true },
      { secret: { answerKey: "[1e3,9007199254740993]" }, text: "The selected value is 1e3.", ok: false },
      { secret: { answerKey: "[1e3,9007199254740993]" }, text: "The selected value is 1000.", ok: false },
      { secret: { answerKey: "[1e3,9007199254740993]" }, text: "The selected value is 9007199254740993.", ok: false },
      { secret: { answerKey: "[1e3,9007199254740993]" }, text: "Use 1000 and 9007199254740993.", ok: false },
      { secret: { sealedPayload: { order: '{"nested":[17,0.50]}' } }, text: "The selected value is 0.50.", ok: false },
      ...[{ sealedPayload: { order: [null] } }, { answerKey: "[null]" }, { answerKey: "[17,null]" }].map(secret => ({
        secret, text: "The selected value is null.", ok: false,
      })),
      { secret: { answerKey: "[17,null]" }, text: "Use 17 and null.", ok: false },
      { secret: { gradingRubric: null }, text: "Explain what null means.", ok: true },
      ...["Compute lambda_1.", "Compute my_lambda.", "Compute \\lambda_1."].map(text => ({
        secret: { answerKey: "\\lambda" }, text, ok: true,
      })),
      ...["The eigenvalue is lambda.", "Compute lambda.", "Compute $\\lambda$.", "Compute λ.", "See [lambda].", "Recall lambda = 2."]
        .map(text => ({ secret: { answerKey: "\\lambda" }, text, ok: false })),
      { secret: { answerKey: "\\epsilon" }, text: "Compute epsilon_0.", ok: true },
      { secret: { answerKey: "variable" }, text: "Compute my_variable.", ok: true },
      { secret: { answerKey: "variable" }, text: "Read the variable before continuing.", ok: false },
    ])("sets ok=$ok for $text with $secret", ({ secret, text, ok }) => {
      const variant = makeMissVariantCandidate({
        answerKey: undefined,
        canonicalSolution: undefined,
        gradingRubric: undefined,
        referenceAnswer: undefined,
        sealedPayload: {},
        ...secret,
        freshVariantStem: surface === "variant stem" ? text : "Which ordering is correct?",
      });
      const candidates = surface === "variant stem" ? [variant] : [
        variant,
        { ...makeFlashcardCandidate(900), [surface]: text },
      ];
      expect(issueOfflineFlashcardLease({
        leaseId: "lease-formatted-choice-and-json-literal",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates,
      })).toMatchObject(ok ? { ok: true } : { ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
    });
  });

  it.each([
    { answerKey: "[17,9007199254740993.0]", text: "Use 17 and 9007199254740993.", leaks: true },
    { answerKey: "[17,9007199254740993.0]", text: "Use 17 and 9007199254740992.", leaks: false },
    { answerKey: "[17,1e-400]", text: "Use 17 and 0.", leaks: false },
    { answerKey: "[17,1e3]", text: "Use 17 and 2.1e3.", leaks: false },
    { answerKey: "[17,1e3]", text: "Use 17 and 1000.", leaks: true },
    { answerKey: "[1e3,17]", text: "Use 2.1e3 and 17.", leaks: false },
    { answerKey: "[0.0000001,1e3]", text: "Use 1e-7 and 1000.", leaks: true },
    { answerKey: "[0.0000001,1e3]", text: "Use 50 and 1e-7 and 1000.", leaks: true },
    { answerKey: "[0.0000001,1e3]", text: "Compare 1000 and 1e-7.", leaks: false },
    { answerKey: "[0.0000001,1e3]", text: "Use [1e-7] and [-1000].", leaks: false },
    { answerKey: "[0.0000001,-1e3]", text: "Use [1e-7] and [-1000].", leaks: true },
    { answerKey: "[1e-400,17]", text: "Use 0.1e-399 and 17.", leaks: true },
    { answerKey: "[1e9007199254740993,17]", text: "Use 0.1e9007199254740994 and 17.", leaks: true },
    { answerKey: "[1, 234]", text: "Use [1,234].", leaks: true },
    { answerKey: '["1","234"]', text: "Use (1,234).", leaks: true },
    { answerKey: "[1000,0.5]", text: "Use 1,000 and 0.5_0.", leaks: true },
    { answerKey: "[1000,0.5]", text: "Use 1\u202F000 and 0.5.", leaks: true },
    { answerKey: "[100000,0.5]", text: "Use 1,00,000 and 0.5.", leaks: true },
  ])("matches only the exact numeric sequence $answerKey in $text", ({ answerKey, text, leaks }) => {
    expect(containsAnswerLeak(text, answerKey)).toBe(leaks);
  });

  describe.each(["variant stem", "prompt", "backSummary"] as const)("numeric and cue boundaries in a %s", surface => {
    it.each([
      { answerKey: "[1e3]", text: "Compare 2.1e3 with the threshold.", ok: true },
      { answerKey: "[1e3]", text: "Compare .1e3 with the threshold.", ok: true },
      { answerKey: "[1e3]", text: "Compare 1e30 with the threshold.", ok: true },
      { answerKey: "[1e3]", text: "The selected value is 1e3.", ok: false },
      { answerKey: "[1e3]", text: "The selected value is 1000.", ok: false },
      ...["1_000", "1,000", "1,000.0", "1_0e+0_2"].map(value => ({
        answerKey: "[1000]", text: `The selected value is ${value}.`, ok: false,
      })),
      ...[new Intl.NumberFormat("fr-FR").format(1000), "1\u00A0000", "1\u2009000",
        "1\u2007000", "1'000", "1\u2019000", "１\u202F０００"].map(value => ({
        answerKey: "[1000]", text: `The selected value is ${value}.`, ok: false,
      })),
      { answerKey: "[1000]", text: "The selected value is 1.000.", ok: true },
      { answerKey: "[1]", text: "The selected value is 1.000.", ok: false },
      { answerKey: "[1]", text: "Compare 1\u202F000 with the threshold.", ok: true },
      { answerKey: "[1000]", text: "Compare -1\u202F000 with the threshold.", ok: true },
      { answerKey: "[-1000]", text: "The selected value is -1\u00A0000.", ok: false },
      { answerKey: "[1000000.5]", text: "The selected value is 1\u202F000\u202F000.5.", ok: false },
      { answerKey: "[1000000.5]", text: "The selected value is 1\u202F000\u00A0000.5.", ok: true },
      { answerKey: "[100000]", text: "The selected value is 1,00,000.", ok: false },
      { answerKey: "[1000]", text: "Consider the two labels 1 000.", ok: true },
      { answerKey: "[1000]", text: "The selected value is 0.1000.", ok: true },
      { answerKey: "[1000]", text: "Compare -1,000 with the threshold.", ok: true },
      { answerKey: "[-1000]", text: "The selected value is -1_000.", ok: false },
      { answerKey: "[-1000]", text: "The selected value is -1,000.", ok: false },
      { answerKey: "1000000", text: "The selected value is 1_000_000.", ok: false },
      { answerKey: "12345678", text: "The selected value is 12,345,678.", ok: false },
      { answerKey: "1000.5", text: "The selected value is 1_000.5_0.", ok: false },
      { answerKey: "1000.5", text: "The selected value is 1,000.5.", ok: false },
      { answerKey: "1e-7", text: "The selected value is 0.000_000_1.", ok: false },
      { answerKey: "1e-6", text: "The selected value is 1_0e-7.", ok: false },
      { answerKey: "234", text: "Compare 1,234 with the threshold.", ok: true },
      { answerKey: "5", text: "Solve x - 5 = 0.", ok: false },
      { answerKey: "5", text: "Answer - 5", ok: false },
      { answerKey: "-5", text: "Answer - 5", ok: false },
      { answerKey: "5", text: "Answer -5", ok: true },
      { answerKey: "[1, 234]", text: "Use [1,234].", ok: false },
      { answerKey: "[1e3]", text: "The result is…1000.", ok: false },
      { answerKey: "[1e3]", text: "The result is 1..1000.", ok: false },
      { answerKey: "[0.1]", text: "The result is…1000.", ok: true },
      { answerKey: "[1e3]", text: "Compare -1e3 with the threshold.", ok: true },
      { answerKey: "[1e3]", text: "Compare - ( 1e3 ) with the threshold.", ok: true },
      { answerKey: "[1e3]", text: "The result = 1e3.", ok: false },
      { answerKey: "[1e3]", text: "The result is +1e3.", ok: false },
      { answerKey: "[-1e3]", text: "Compare -1000 with the threshold.", ok: false },
      { answerKey: "[-1e3]", text: "Compare - ( 1000 ) with the threshold.", ok: false },
      { answerKey: "[-1e3]", text: "Evaluate x - 1000.", ok: true },
      { answerKey: "[0]", text: "The result is -0.", ok: false },
      { answerKey: "[0.0000001]", text: "The result is 1e-7.", ok: false },
      { answerKey: "0.0000001", text: "The result is 1e-7.", ok: false },
      { answerKey: "1e-7", text: "The result is 0.0000001.", ok: false },
      { answerKey: "-3", text: "The scale is 1e-3.", ok: true },
      { answerKey: "3", text: "The scale is 1e+3 or 1e-3.", ok: true },
      { answerKey: "2", text: "The scale is 2e3.", ok: true },
      { answerKey: "2.1", text: "The scale is 2.1e3.", ok: true },
      { answerKey: "5", text: "The scale is .5.", ok: true },
      { answerKey: "-2e-3", text: "Solve x -2e-3 = 0.", ok: true },
      { answerKey: "-2e-3", text: "The selected value is -2e-3.", ok: false },
      { answerKey: "100000", text: "Compare 2.100000 with the threshold.", ok: true },
      { answerKey: "[9007199254740993.0]", text: "The selected value is 9007199254740993.", ok: false },
      { answerKey: "[9007199254740993.0]", text: "The selected value is 9007199254740993.0.", ok: false },
      { answerKey: "[9007199254740993.0]", text: "Start from 9007199254740992.", ok: true },
      { answerKey: '{"nested":[9007199254740993.0]}', text: "Start from 9007199254740992.", ok: true },
      { answerKey: '{"nested":[9007199254740993.0]}', text: "The selected value is 9007199254740993.", ok: false },
      { answerKey: "[1e-400]", text: "Start from 0.", ok: true },
      { answerKey: "[1e-400]", text: "The selected value is 1e-400.", ok: false },
      { answerKey: "[1e-400]", text: "The selected value is 0.1e-399.", ok: false },
      { answerKey: "[1e-400]", text: "Compare 2.1e-400 with the threshold.", ok: true },
      { answerKey: "[0e-400]", text: "The selected value is 0.", ok: false },
      { answerKey: "[-0.0]", text: "The selected value is 0.", ok: false },
      { answerKey: "[123e-4]", text: "The selected value is 0.0123.", ok: false },
      { answerKey: "[-0.0500e+02]", text: "The selected value is -5.", ok: false },
      ...["Give the monkey *a* banana.", "Give the monkey a banana.", "Give humans *a* chance.", "Give spans a width."].map(text => ({
        answerKey: "A", text, ok: true,
      })),
      ...["Can you correct a mistake?", "Correct a calculation error.", "Correct a sign error first.", "What is a matrix?",
        "Select a valid approach.", "Choose a basis vector."].map(text => ({
        answerKey: "A", text, ok: true,
      })),
      ...["Answer key: *a*", "Key is A", "Key is a", "Key: A", "Answer: A", "Option A in the list", "Choice (a) under review"].map(text => ({
        answerKey: "A", text, ok: false,
      })),
      ...["answerKey: A.", "answer_key: A.", "correctAnswer: A.", "final-answer: A.",
        "The correct answer is: A.", "Answer is = A.", "正确答案是：A。",
        "Correct answer: A", "The correct option is a.", "Correct — A", "Option A is correct.",
        "Correct A.", "Correct (A) for this item.", "Correct (a) for this item.", 'Correct "a"',
        "Correct a.", "Correct a\n  Show your work.", "Correct A for this item.", "Correct: a", "Correct — a",
        "Correct option a", "Choice a", "Option a is correct", "Answer: a", "Answer is a", "The answer is a.",
        "A is correct.", "Correct response is A.", "Correct letter is A.", "Correct value is A.",
        ...["-", "–", "—", "―"].map(separator => `Answer ${separator} A`)].map(text => ({
        answerKey: "A", text, ok: false,
      })),
      ...["->", "=>", "-->", "==>", "→", "⇒", "⟶", "⟹"].map(separator => ({
        answerKey: "B", text: `Solution ${separator} B`, ok: false,
      })),
      ...["Correct B.", "Correct (B) for this item.", "The solution is: B.", "The solution — B",
        "Solutions — B", "Result — B", "Selection — B",
        "solutionKey — B", "correctSolution — B", "correct_solution — B", "final_solution — B", "final_result — B"].map(text => ({
        answerKey: "B", text, ok: false,
      })),
      { answerKey: "B", text: "Ans = B for the first question.", ok: false },
      { answerKey: "B", text: "Correct option is B in the first question.", ok: false },
      { answerKey: "B", text: "selectedOption = B.", ok: false },
    ])("sets ok=$ok for $text with $answerKey", ({ answerKey, text, ok }) => {
      const variant = makeMissVariantCandidate({
        answerKey,
        canonicalSolution: undefined,
        gradingRubric: undefined,
        referenceAnswer: undefined,
        sealedPayload: {},
        freshVariantStem: surface === "variant stem" ? text : "Which ordering is correct?",
      });
      const candidates = surface === "variant stem" ? [variant] : [
        variant,
        { ...makeFlashcardCandidate(900), [surface]: text },
      ];
      expect(issueOfflineFlashcardLease({
        leaseId: "lease-numeric-and-cue-boundaries",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates,
      })).toMatchObject(ok ? { ok: true } : { ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
    });

    it.each([
      { order: [1e-7], text: "The result is 0.0000001." },
      { order: [1000], text: "The result is 1_000." },
      { order: [1000], text: "The result is 1,000." },
      { order: [1000], text: `The result is ${new Intl.NumberFormat("fr-FR").format(1000)}.` },
      { order: [1, 234], text: "Use [1,234]." },
    ])("rejects $text for native protected array $order", ({ order, text }) => {
      const variant = makeMissVariantCandidate({
        answerKey: undefined,
        canonicalSolution: undefined,
        gradingRubric: undefined,
        referenceAnswer: undefined,
        sealedPayload: { order },
        freshVariantStem: surface === "variant stem" ? text : "Which ordering is correct?",
      });
      const candidates = surface === "variant stem" ? [variant] : [
        variant,
        { ...makeFlashcardCandidate(900), [surface]: text },
      ];
      expect(issueOfflineFlashcardLease({
        leaseId: "lease-native-scientific-member",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates,
      })).toMatchObject({ ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
    });
  });

  it("rejects a candidate with an inherited protected getter without invoking it", () => {
    let getterCalled = false;
    const candidate = makeMissVariantCandidate({ freshVariantStem: "The indicator turns violet." });
    Reflect.deleteProperty(candidate, "answerKey");
    Object.setPrototypeOf(candidate, {
      get answerKey() {
        getterCalled = true;
        return "violet";
      },
    });
    expect(issueOfflineFlashcardLease({
      leaseId: "lease-prototype-secret",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [candidate],
    })).toMatchObject({ ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
    expect(getterCalled).toBe(false);
  });

  it.each(["request", "candidate list", "candidate"] as const)(
    "rejects a known getter on the %s without invoking it",
    target => {
      let getterCalled = false;
      const candidate = makeMissVariantCandidate();
      const input = {
        leaseId: "lease-accessor",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates: [candidate],
      };
      const defineGetter = (record: object, key: string, value: unknown) => {
        Object.defineProperty(record, key, {
          get() {
            getterCalled = true;
            return value;
          },
        });
      };
      if (target === "request") defineGetter(input, "candidates", input.candidates);
      if (target === "candidate list") defineGetter(input.candidates, "0", candidate);
      if (target === "candidate") defineGetter(candidate, "freshVariantStem", "Find the result.");
      expect(issueOfflineFlashcardLease(input))
        .toMatchObject({ ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
      expect(getterCalled).toBe(false);
    },
  );

  it.each(["candidate list", "nested payload"] as const)(
    "rejects a named array getter on the %s without invoking it",
    surface => {
      const nested: unknown[] = ["violet"];
      const candidates = [makeMissVariantCandidate({ sealedPayload: { nested } })];
      const array = surface === "candidate list" ? candidates : nested;
      let getterCalled = false;
      Object.defineProperty(array, "answerKey", {
        get() {
          getterCalled = true;
          return "violet";
        },
      });
      expect(issueOfflineFlashcardLease({
        leaseId: "lease-array-own-getter",
        workspaceId: "ws-1",
        learnerId: "learner-1",
        issuedAtMs: T0,
        candidates,
      })).toMatchObject({ ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
      expect(getterCalled).toBe(false);
    },
  );

  it.each([
    ["candidate list", "01"],
    ["candidate list", Symbol("extra")],
    ["nested payload", "01"],
    ["nested payload", Symbol("extra")],
  ] as const)("rejects non-index array data on the %s at %s", (surface, key) => {
    const nested = ["violet"];
    const candidates = [makeMissVariantCandidate({ sealedPayload: { nested } })];
    Object.defineProperty(surface === "candidate list" ? candidates : nested, key, { value: "extra" });
    expect(issueOfflineFlashcardLease({
      leaseId: "lease-array-extra-data",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates,
    })).toMatchObject({ ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
  });

  it.each(["candidate list", "nested payload"] as const)(
    "rejects an Array.prototype protected getter on the %s without invoking it",
    surface => {
      const candidates = [makeMissVariantCandidate({ sealedPayload: { nested: ["violet"] } })];
      if (surface === "nested payload") Object.setPrototypeOf(candidates, null);
      let getterCalled = false;
      Object.defineProperty(Array.prototype, "answerKey", {
        configurable: true,
        get() {
          getterCalled = true;
          return "violet";
        },
      });
      let result: ReturnType<typeof issueOfflineFlashcardLease>;
      try {
        result = issueOfflineFlashcardLease({
          leaseId: "lease-array-inherited-getter",
          workspaceId: "ws-1",
          learnerId: "learner-1",
          issuedAtMs: T0,
          candidates,
        });
      } finally {
        Reflect.deleteProperty(Array.prototype, "answerKey");
      }
      expect(result).toMatchObject({ ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
      expect(getterCalled).toBe(false);
    },
  );

  it("rejects an Object.prototype protected data field inherited by the candidate array", () => {
    const input = {
      leaseId: "lease-array-inherited-data",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [makeMissVariantCandidate()],
    };
    Object.setPrototypeOf(input, null);
    Object.defineProperty(Object.prototype, "answerKey", { configurable: true, value: "violet" });
    let result: ReturnType<typeof issueOfflineFlashcardLease>;
    try {
      result = issueOfflineFlashcardLease(input);
    } finally {
      Reflect.deleteProperty(Object.prototype, "answerKey");
    }
    expect(result).toMatchObject({ ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
  });

  it("accepts plain records with null prototypes at issuance", () => {
    const candidate = makeMissVariantCandidate();
    Object.setPrototypeOf(candidate, null);
    const input = {
      leaseId: "lease-plain-data",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [candidate],
    };
    Object.setPrototypeOf(input, null);
    expect(issueOfflineFlashcardLease(input)).toMatchObject({ ok: true });
  });

  it.each(["variant stem", "sibling card"] as const)("rejects nested sealed answers in a %s", surface => {
    const sealedPayload = { exam: { items: [{ rubric: { answer: "violet" } }] } };
    const safeStem = "What color does the indicator show?";
    const leakedText = "The indicator turns violet.";
    const candidate = makeMissVariantCandidate({
      sealedPayload,
      freshVariantStem: surface === "variant stem" ? leakedText : safeStem,
    });
    const candidates = surface === "variant stem" ? [candidate] : [
      candidate,
      { ...makeFlashcardCandidate(900), prompt: leakedText, backSummary: "Recall the indicator colors." },
    ];
    expect(issueOfflineFlashcardLease({
      leaseId: "lease-nested-secret",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates,
    })).toMatchObject({ ok: false, httpStatus: 422, code: "miss_variant_answer_leak" });
  });

  it.each([
    ["recursive record", () => {
      const record: Record<string, unknown> = {};
      record.self = record;
      return { sealedPayload: record };
    }],
    ["recursive array in another protected field", () => {
      const array: unknown[] = [];
      array.push(array);
      return { gradingRubric: { nested: array } };
    }],
    ["over-depth payload", () => {
      let nested: unknown = "violet";
      for (let depth = 0; depth < 65; depth += 1) nested = { nested };
      return { sealedPayload: nested };
    }],
    ["over-budget payload", () => ({ sealedPayload: Array.from({ length: 4_096 }, () => null) })],
  ] as const)("rejects uninspectable protected data (%s) even when the stem has no answer", (_label, buildProtectedFields) => {
    expect(issueOfflineFlashcardLease({
      leaseId: "lease-uninspectable-secret",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [makeMissVariantCandidate({
        freshVariantStem: "What color does the indicator show?",
        ...buildProtectedFields(),
      })],
    })).toMatchObject({ ok: false, httpStatus: 422, code: "miss_variant_answer_leak", cardId: "miss-card-1" });
  });

  it("allows a repeated acyclic protected object when none of its values leak", () => {
    const rubric = { answer: "violet" };
    expect(issueOfflineFlashcardLease({
      leaseId: "lease-shared-secret",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      issuedAtMs: T0,
      candidates: [makeMissVariantCandidate({
        freshVariantStem: "What color does the indicator show?",
        sealedPayload: { exam: { items: [{ rubric }, { rubric }] } },
      })],
    })).toMatchObject({ ok: true });
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
    const leaseUuidLower = "22222222-3333-4444-8555-66666666aaaa";
    const leaseUuidUpper = leaseUuidLower.toUpperCase();
    const cardUuidLower = "33333333-4444-4555-8666-77777777bbbb";
    const cardUuidUpper = cardUuidLower.toUpperCase();
    expect(leaseUuidUpper).not.toBe(leaseUuidLower);
    expect(cardUuidUpper).not.toBe(cardUuidLower);
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

    // [Round-8 P2 / Round-9 P2] Pre-Round-7 stored ledger entry whose payloadFingerprint was hashed from
    // raw uppercase hex-letter UUIDs MUST replay idempotently (both uppercase and lowercase retries),
    // while genuine payload mutations STILL return 409 seq_payload_mismatch!
    const preR7LeaseUuidLower = "550e8400-e29b-41d4-a716-4466554400ab";
    const preR7LeaseUuidUpper = preR7LeaseUuidLower.toUpperCase();
    const preR7CardUuidLower = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    const preR7CardUuidUpper = preR7CardUuidLower.toUpperCase();
    expect(preR7LeaseUuidUpper).not.toBe(preR7LeaseUuidLower);
    expect(preR7CardUuidUpper).not.toBe(preR7CardUuidLower);
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
    expect(preR7RawUppercaseFingerprint).not.toBe(
      computeOfflineOutboxPayloadFingerprint(preR7EntryUpper),
    );

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
