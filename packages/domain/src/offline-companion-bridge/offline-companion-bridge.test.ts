import { describe, expect, it } from "vitest";
import {
  BASE_PRIOR_ALPHA,
  BASE_PRIOR_BETA,
  COMPANION_ALLOWED_ACTIONS,
  COMPANION_FORBIDDEN_ACTIONS,
  COMPANION_PAIRING_TTL_MS,
  FORBIDDEN_MISS_VARIANT_FIELDS,
  MAX_BRIDGE_PRIOR_MEAN,
  MAX_BRIDGE_PSEUDO_OBSERVATIONS,
  MAX_OFFLINE_LEASE_CARDS,
  MIN_BRIDGE_PRIOR_MEAN,
  OFFLINE_LEASE_TTL_MS,
  appendCompanionScratchpadPage,
  authorizeCompanionAction,
  computeCrossCourseWeakPrior,
  createCompanionPairingOffer,
  createCompanionScratchpadDraft,
  createInitialOfflineFsrsSnapshot,
  deriveCompanionFragmentSecretProof,
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
    freshVariantStem: "Compute the determinant of [[2, 1], [5, 3]] without looking at notes.",
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
    expect(firstPass.nextProcessedLedger[offlineOutboxIdempotencyKey("lease-settle-1", 1)]).toBeDefined();
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
    expect(raceResult.results[0]).toMatchObject({ outcome: "reviewed_elsewhere", httpStatus: 409 });
    expect(raceResult.results[1]).toMatchObject({ outcome: "reviewed_elsewhere", httpStatus: 409 });
    expect(raceResult.updatedServerCards).toEqual(racedCards);

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
  const COMPANION_ORIGIN = "https://scratchpad.aistudy.example";
  const DEVICE_CODE = "dev_code_9f8a7b6c5d4e3f2a1b0c";
  const FRAGMENT_SECRET = "ephemeral_frag_secret_77aa88bb99cc";
  const RAW_USER_CODE = "ab23 cd45";

  it("enforces origin isolation, fragment-only QR secret, ambiguous-char user code rejection, 90s TTL, and single-use replay revocation", () => {
    expect(COMPANION_PAIRING_TTL_MS).toBe(90_000);
    expect(normalizeOrigin("HTTPS://App.AIStudy.Example:443")).toBe("https://app.aistudy.example");
    expect(normalizeCompanionUserCode("ab23-cd45")).toBe("AB23-CD45");
    expect(normalizeCompanionUserCode("AB01-CDIL")).toBeNull();
    expect(normalizeCompanionUserCode("ABOO-CD23")).toBeNull();

    const generatedCode = formatCompanionUserCodeFromBytes(new Uint8Array([0, 1, 2, 3, 28, 29, 30, 31]));
    expect(generatedCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

    // Same origin (including case / default-port equivalence) MUST fail closed.
    const sameOrigin = createCompanionPairingOffer({
      offerId: "offer-bad-origin",
      workspaceId: "ws-1",
      learnerId: "learner-1",
      attemptId: "attempt-1",
      primaryOrigin: "https://app.aistudy.example:443",
      allowedCompanionOrigin: "HTTPS://APP.AISTUDY.EXAMPLE",
      issuedAtMs: T0,
      deviceCode: DEVICE_CODE,
      userCode: RAW_USER_CODE,
      fragmentSecret: FRAGMENT_SECRET,
    });
    expect(sameOrigin.ok).toBe(false);
    if (!sameOrigin.ok) expect(sameOrigin.code).toBe("origin_isolation_violation");

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

    // Second redemption attempt MUST signal immediate revocation of the issued session!
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

    // Cross-attempt access rejected with 403 attempt_mismatch.
    expect(
      authorizeCompanionAction({
        session,
        action: "upload_page",
        attemptId: "attempt-999",
        nowMs: T0 + 10_000,
      }),
    ).toMatchObject({ allowed: false, httpStatus: 403, reason: "attempt_mismatch" });

    // Expired & revoked sessions rejected cleanly.
    expect(
      authorizeCompanionAction({
        session,
        action: "heartbeat",
        attemptId: "attempt-42",
        nowMs: session.expiresAtMs + 1,
      }),
    ).toMatchObject({ allowed: false, httpStatus: 403, reason: "session_expired" });

    const revokedSession = revokeCompanionSession(session, T0 + 15_000, "pairing_replay_detected");
    expect(
      authorizeCompanionAction({
        session: revokedSession,
        action: "upload_page",
        attemptId: "attempt-42",
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

    const up1 = appendCompanionScratchpadPage(draft0, {
      pageNumber: 1,
      objectKey: "scratchpad/attempt-42/p1.png",
      sha256: shaA,
      byteLength: 42_000,
      uploadedAtMs: T0 + 20_000,
      session,
      requestOrigin: COMPANION_ORIGIN,
    });
    expect(up1.ok).toBe(true);
    if (!up1.ok) throw new Error("expected page 1");
    expect(up1.draftRevision).toBe(1);

    // Tablet races page 2 before desktop clicks submit using stale preview revision 1.
    const up2 = appendCompanionScratchpadPage(up1.state, {
      pageNumber: 2,
      objectKey: "scratchpad/attempt-42/p2.png",
      sha256: shaB,
      byteLength: 55_000,
      uploadedAtMs: T0 + 25_000,
      session,
      requestOrigin: COMPANION_ORIGIN,
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
      pageNumber: 3,
      objectKey: "scratchpad/attempt-42/p3.png",
      sha256: shaC,
      byteLength: 10_000,
      uploadedAtMs: T0 + 40_000,
      session,
      requestOrigin: COMPANION_ORIGIN,
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
    expect(MAX_BRIDGE_PSEUDO_OBSERVATIONS).toBe(1);
    expect(MAX_BRIDGE_PRIOR_MEAN).toBeCloseTo(2 / 3, 12);

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
          sourceMasteryProbability: 1,
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

  it("caps aggregated pseudo-observations at <= 1 (posteriorMean strictly within [1/3, 2/3])", () => {
    const manyStrongEdges = Array.from({ length: 20 }, (_, i) => ({
      edgeId: `strong-${i}`,
      sourceCourseId: `course-${i}`,
      sourceConceptId: `concept-${i}`,
      targetCourseId: "course-target",
      targetConceptId: "target-concept",
      alignmentWeight: 1,
      sourceMasteryProbability: 1,
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
    expect(upperBound.equivalentObservations).toBeCloseTo(1, 12);
    expect(upperBound.deltaAlpha + upperBound.deltaBeta).toBeLessThanOrEqual(1 + 1e-12);
    expect(upperBound.alpha).toBeCloseTo(2, 12);
    expect(upperBound.beta).toBeCloseTo(1, 12);
    expect(upperBound.posteriorMean).toBeCloseTo(MAX_BRIDGE_PRIOR_MEAN, 12);
    expect(upperBound.posteriorMean).toBeLessThanOrEqual(MAX_BRIDGE_PRIOR_MEAN);

    const manyWeakEdges = manyStrongEdges.map(e => ({ ...e, sourceMasteryProbability: 0 }));
    const lowerBound = computeCrossCourseWeakPrior({
      targetCourseId: "course-target",
      targetConceptId: "target-concept",
      edges: manyWeakEdges,
      coursePrivacyEpochs: epochs,
      activeCourseSharingEnabled: sharing,
      revokedSourceIds: new Set<string>(),
    });
    expect(lowerBound.posteriorMean).toBeCloseTo(MIN_BRIDGE_PRIOR_MEAN, 12);
    expect(lowerBound.posteriorMean).toBeGreaterThanOrEqual(MIN_BRIDGE_PRIOR_MEAN);
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
        sourceMasteryProbability: 0.95,
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
        sourceMasteryProbability: 0.9,
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
        sourceMasteryProbability: 0.85,
        sourceDirectObservationCount: 5,
        edgePrivacyEpoch: 2,
        supportingSourceIds: ["src-c1", "src-c2-revoked"],
      },
    ];

    // Before revocation: all 3 active -> posteriorMean boosted above 0.5 and <= 2/3.
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

  it("rejects same-course, multi-hop flagged, missing-epoch, and duplicate-edge weight inflation", () => {
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
          alignmentWeight: 1,
          sourceMasteryProbability: 1,
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
          alignmentWeight: 1,
          sourceMasteryProbability: 1,
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
          alignmentWeight: 0.9,
          sourceMasteryProbability: 1,
          sourceDirectObservationCount: 10,
          edgePrivacyEpoch: 1,
          supportingSourceIds: [],
        },
        // Duplicate identical (sourceCourseId, sourceConceptId) edge with weight 0.4 must NOT inflate to 0.8.
        {
          edgeId: "valid-dup-1",
          sourceCourseId: "course-valid",
          sourceConceptId: "linear-comb",
          targetCourseId: "course-target",
          targetConceptId: "span",
          alignmentWeight: 0.4,
          sourceMasteryProbability: 0.9,
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
          alignmentWeight: 0.4,
          sourceMasteryProbability: 0.9,
          sourceDirectObservationCount: 4,
          edgePrivacyEpoch: 7,
          supportingSourceIds: ["src-v1"],
        },
      ],
      coursePrivacyEpochs: { "course-a": 1, "course-target": 1, "course-valid": 7 },
      activeCourseSharingEnabled: {
        "course-a": true,
        "course-target": true,
        "course-unknown": true,
        "course-valid": true,
      },
      revokedSourceIds: new Set<string>(),
    });

    expect(result.ignoredNonDirectEdges).toEqual([
      expect.objectContaining({ edgeId: "same-course", reason: "same_course_edge" }),
    ]);
    expect(result.decoupledEdges).toEqual([
      expect.objectContaining({ edgeId: "multi-hop-flagged", reason: "multi_hop_rejected" }),
      expect.objectContaining({ edgeId: "missing-epoch", reason: "privacy_epoch_mismatch" }),
    ]);
    expect(result.acceptedEdges).toHaveLength(1);
    expect(result.equivalentObservations).toBeCloseTo(0.4, 12);
    expect(result.deltaAlpha).toBeCloseTo(0.36, 12);
    expect(result.deltaBeta).toBeCloseTo(0.04, 12);
    expect(result.posteriorMean).toBeCloseTo(1.36 / 2.4, 12);
  });
});
