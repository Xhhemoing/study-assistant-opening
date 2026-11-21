/**
 * Shared browser-safe types and constants for the Closed-Core Wave R / Lane R4
 * domain engine:
 * - 12h single-active offline flashcard lease & idempotent outbox settlement
 * - RFC 8628 90s companion scratchpad pairing, capability firewall & atomic freeze
 * - 1-hop bounded cross-course concept bridge weak prior with read-time privacy epoch
 */

/* -------------------------------------------------------------------------- */
/* A. 12h Single-Active Offline Flashcard Lease & Outbox                      */
/* -------------------------------------------------------------------------- */

export const MAX_OFFLINE_LEASE_CARDS = 30;
export const OFFLINE_LEASE_TTL_MS = 12 * 3_600_000; // 43_200_000 ms (12h)

export const FORBIDDEN_MISS_VARIANT_FIELDS = [
  "answerKey",
  "canonicalSolution",
  "gradingRubric",
  "sealedPayload",
  "referenceAnswer",
] as const;

export type ForbiddenMissVariantField = (typeof FORBIDDEN_MISS_VARIANT_FIELDS)[number];

export type OfflineLeaseStatus = "active" | "superseded" | "revoked" | "expired";

export type OfflineRawRating = "again" | "hard" | "good" | "easy";
export type OfflineEffectiveRating = "again" | "hard" | "good";

export interface OfflineFlashcardCandidate {
  readonly cardId: string;
  readonly cardKind: "flashcard";
  readonly cardRevision: number;
  readonly lastServerReviewedAtMs: number | null;
  readonly prompt: string;
  readonly backSummary: string;
  readonly [extraKey: string]: unknown;
}

export interface OfflineMissVariantCandidate {
  readonly cardId: string;
  readonly cardKind: "miss_variant";
  readonly cardRevision: number;
  readonly lastServerReviewedAtMs: number | null;
  readonly freshVariantId: string;
  readonly freshVariantStem: string;
  readonly answerKey?: string | null;
  readonly canonicalSolution?: string | null;
  readonly gradingRubric?: string | null;
  readonly sealedPayload?: unknown;
  readonly referenceAnswer?: string | null;
  readonly [extraKey: string]: unknown;
}

export type OfflineLeaseCardCandidate = OfflineFlashcardCandidate | OfflineMissVariantCandidate;

export interface OfflineLeasedStandardFlashcard {
  readonly cardId: string;
  readonly cardKind: "flashcard";
  readonly cardRevision: number;
  readonly lastServerReviewedAtMs: number | null;
  readonly prompt: string;
  readonly backSummary: string;
}

export interface OfflineLeasedMissVariantCard {
  readonly cardId: string;
  readonly cardKind: "miss_variant";
  readonly cardRevision: number;
  readonly lastServerReviewedAtMs: number | null;
  readonly freshVariantId: string;
  readonly freshVariantStem: string;
}

export type OfflineLeaseCard = OfflineLeasedStandardFlashcard | OfflineLeasedMissVariantCard;

export interface OfflineFlashcardLease {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly workspaceId: string;
  readonly learnerId: string;
  readonly status: OfflineLeaseStatus;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly supersededAtMs: number | null;
  readonly supersededByLeaseId: string | null;
  readonly revokedAtMs: number | null;
  readonly cards: ReadonlyArray<OfflineLeaseCard>;
}

export interface IssueOfflineFlashcardLeaseInput {
  readonly leaseId: string;
  readonly workspaceId: string;
  readonly learnerId: string;
  readonly issuedAtMs: number;
  readonly candidates: ReadonlyArray<OfflineLeaseCardCandidate>;
  readonly existingActiveLease?: OfflineFlashcardLease | null;
}

export type IssueOfflineLeaseFailureCode =
  | "invalid_lease_scope"
  | "invalid_timestamp"
  | "empty_lease_cards"
  | "lease_card_limit_exceeded"
  | "duplicate_card_id"
  | "invalid_card_payload"
  | "miss_variant_stem_required"
  | "miss_variant_answer_leak"
  | "supersede_scope_mismatch"
  | "duplicate_lease_id";

export type IssueOfflineFlashcardLeaseResult =
  | {
      readonly ok: true;
      readonly lease: OfflineFlashcardLease;
      readonly supersededLeaseId: string | null;
      readonly supersededLease: OfflineFlashcardLease | null;
    }
  | {
      readonly ok: false;
      readonly code: IssueOfflineLeaseFailureCode;
      readonly httpStatus: 400 | 409 | 422;
      readonly message: string;
      readonly cardId?: string;
    };

export interface OfflineFsrsMemoryState {
  readonly stability: number;
  readonly difficulty: number;
  readonly elapsedDays: number;
  readonly scheduledDays: number;
  readonly learningSteps: number;
  readonly reps: number;
  readonly lapses: number;
  readonly state: number;
  readonly lastReviewAtMs: number | null;
}

export interface ServerFlashcardSnapshot {
  readonly cardId: string;
  readonly revision: number;
  readonly lastServerReviewedAtMs: number | null;
  readonly dueAtMs: number;
  readonly intervalDays: number;
  readonly reps: number;
  readonly lapses: number;
  readonly lastGrade: OfflineRawRating | null;
  readonly updatedAtMs: number;
  readonly fsrs: OfflineFsrsMemoryState | null;
}

export interface OfflineOutboxEntryInput {
  readonly leaseId: string;
  readonly seq: number;
  readonly cardId: string;
  readonly expectedCardRevision: number;
  readonly rating: OfflineRawRating;
  readonly clientReviewedAtMs?: number | null;
  readonly responseSummary?: string | null;
  readonly delayedCheck?: unknown;
  readonly transferVerified?: unknown;
  readonly promoteMastery?: unknown;
  readonly [extraKey: string]: unknown;
}

export interface OfflineSettledReceipt {
  readonly leaseId: string;
  readonly seq: number;
  readonly cardId: string;
  readonly rawRating: OfflineRawRating;
  readonly effectiveRating: OfflineEffectiveRating;
  readonly clampedFromEasy: boolean;
  readonly authorityClock: "server_receipt";
  readonly effectiveReviewedAtMs: number;
  readonly delayedCheckMinted: false;
  readonly allowMasteryPromotion: false;
  readonly transferVerified: false;
  readonly strippedClientFlags: ReadonlyArray<string>;
  readonly previousRevision: number;
  readonly newRevision: number;
  readonly nextSnapshot: ServerFlashcardSnapshot;
}

export type OfflineOutboxItemResult =
  | {
      readonly leaseId: string;
      readonly seq: number;
      readonly cardId: string;
      readonly outcome: "settled";
      readonly httpStatus: 200;
      readonly payloadFingerprint: string;
      readonly effectiveRating: OfflineEffectiveRating;
      readonly clampedFromEasy: boolean;
      readonly authorityClock: "server_receipt";
      readonly effectiveReviewedAtMs: number;
      readonly delayedCheckMinted: false;
      readonly allowMasteryPromotion: false;
      readonly transferVerified: false;
      readonly receipt: OfflineSettledReceipt;
    }
  | {
      readonly leaseId: string;
      readonly seq: number;
      readonly cardId: string;
      readonly outcome: "replayed";
      readonly httpStatus: 200;
      readonly payloadFingerprint: string;
      readonly effectiveRating: OfflineEffectiveRating;
      readonly clampedFromEasy: boolean;
      readonly authorityClock: "server_receipt";
      readonly effectiveReviewedAtMs: number;
      readonly delayedCheckMinted: false;
      readonly allowMasteryPromotion: false;
      readonly transferVerified: false;
      readonly receipt: OfflineSettledReceipt;
    }
  | {
      readonly leaseId: string;
      readonly seq: number;
      readonly cardId: string;
      readonly outcome: "seq_payload_mismatch";
      readonly httpStatus: 409;
      readonly payloadFingerprint: string;
      readonly expectedPayloadFingerprint: string;
      readonly reason: string;
    }
  | {
      readonly leaseId: string;
      readonly seq: number;
      readonly cardId: string;
      readonly outcome: "reviewed_elsewhere";
      readonly httpStatus: 409;
      readonly serverRevision: number;
      readonly leasedCardRevision: number;
      readonly expectedCardRevision: number;
      readonly serverLastReviewedAtMs: number | null;
      readonly reason: string;
    }
  | {
      readonly leaseId: string;
      readonly seq: number;
      readonly cardId: string;
      readonly outcome:
        | "invalid_seq"
        | "invalid_entry"
        | "lease_mismatch"
        | "card_not_in_lease"
        | "card_not_found";
      readonly httpStatus: 400 | 403 | 404 | 409;
      readonly reason: string;
    };

export interface OfflineOutboxLedgerEntry {
  readonly leaseId: string;
  readonly seq: number;
  readonly payloadFingerprint: string;
  readonly receipt: OfflineSettledReceipt;
}

export interface ReconcileOfflineLeaseOutboxInput {
  readonly lease: OfflineFlashcardLease;
  readonly serverCards:
    | Readonly<Record<string, ServerFlashcardSnapshot>>
    | ReadonlyMap<string, ServerFlashcardSnapshot>;
  readonly processedLedger?:
    | Readonly<Record<string, OfflineOutboxLedgerEntry>>
    | ReadonlyMap<string, OfflineOutboxLedgerEntry>;
  readonly serverReceiptAtMs: number;
  readonly entries: ReadonlyArray<OfflineOutboxEntryInput>;
}

export type ReconcileOfflineLeaseOutboxResult =
  | {
      readonly ok: true;
      readonly leaseStatus: "active";
      readonly serverReceiptAtMs: number;
      readonly settledCount: number;
      readonly replayedCount: number;
      readonly conflictCount: number;
      readonly results: ReadonlyArray<OfflineOutboxItemResult>;
      readonly updatedServerCards: Readonly<Record<string, ServerFlashcardSnapshot>>;
      readonly nextProcessedLedger: Readonly<Record<string, OfflineOutboxLedgerEntry>>;
    }
  | {
      readonly ok: false;
      readonly leaseStatus: "lease_expired" | "lease_superseded" | "lease_revoked" | "invalid_server_clock";
      readonly httpStatus: 400 | 403 | 409 | 410;
      readonly serverReceiptAtMs: number;
      readonly settledCount: 0;
      readonly replayedCount: 0;
      readonly conflictCount: 0;
      readonly results: readonly [];
      readonly updatedServerCards: Readonly<Record<string, ServerFlashcardSnapshot>>;
      readonly nextProcessedLedger: Readonly<Record<string, OfflineOutboxLedgerEntry>>;
      readonly message: string;
    };

/* -------------------------------------------------------------------------- */
/* B. RFC 8628 90s Companion Scratchpad Pairing & Atomic Freeze               */
/* -------------------------------------------------------------------------- */

export const COMPANION_PAIRING_TTL_MS = 90_000; // 90 seconds
export const COMPANION_USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const COMPANION_COOKIE_PATH = "/api/companion/scratchpad";

export const COMPANION_ALLOWED_ACTIONS = [
  "upload_page",
  "list_pages",
  "heartbeat",
] as const;

export const COMPANION_FORBIDDEN_ACTIONS = [
  "read_material",
  "tutor_chat",
  "request_hint",
  "read_answer_key",
  "submit_attempt",
] as const;

export type CompanionAllowedAction = (typeof COMPANION_ALLOWED_ACTIONS)[number];
export type CompanionForbiddenAction = (typeof COMPANION_FORBIDDEN_ACTIONS)[number];
export type CompanionAction = CompanionAllowedAction | CompanionForbiddenAction;

export type CompanionPairingStatus = "pending" | "redeemed" | "expired" | "revoked";

export interface CompanionCookieAttributes {
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: "Strict";
  readonly path: "/api/companion/scratchpad";
}

export interface CompanionPairingOffer {
  readonly schemaVersion: 1;
  readonly offerId: string;
  readonly workspaceId: string;
  readonly learnerId: string;
  readonly attemptId: string;
  readonly primaryOrigin: string;
  readonly allowedCompanionOrigin: string;
  readonly userCode: string;
  readonly deviceCodeHash: string;
  readonly expectedFragmentSecretProof: string;
  readonly status: CompanionPairingStatus;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly redeemedAtMs: number | null;
  readonly issuedSessionId: string | null;
  readonly replayDetectedAtMs: number | null;
}

export interface CreateCompanionPairingOfferInput {
  readonly offerId: string;
  readonly workspaceId: string;
  readonly learnerId: string;
  readonly attemptId: string;
  readonly primaryOrigin: string;
  readonly allowedCompanionOrigin: string;
  readonly issuedAtMs: number;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly fragmentSecret: string;
  readonly pairingPath?: string;
}

export type CreateCompanionPairingOfferResult =
  | {
      readonly ok: true;
      readonly offer: CompanionPairingOffer;
      readonly qrUrl: string;
      readonly userCode: string;
      readonly expiresAtMs: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | "invalid_pairing_scope"
        | "invalid_timestamp"
        | "invalid_origin"
        | "origin_isolation_violation"
        | "invalid_user_code"
        | "invalid_secret_material"
        | "invalid_pairing_path";
      readonly httpStatus: 400;
      readonly message: string;
    };

export interface CompanionSession {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly offerId: string;
  readonly workspaceId: string;
  readonly learnerId: string;
  readonly scopedAttemptId: string;
  readonly allowedOrigin: string;
  readonly status: "active" | "revoked" | "expired";
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly revokedAtMs: number | null;
  readonly revokedReason: string | null;
  readonly allowedActions: readonly ["upload_page", "list_pages", "heartbeat"];
  readonly cookieAttributes: CompanionCookieAttributes;
}

export interface RedeemCompanionPairingOfferInput {
  readonly offer: CompanionPairingOffer;
  readonly sessionId: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly fragmentSecretProof: string;
  readonly requestOrigin: string;
  readonly nowMs: number;
  readonly sessionTtlMs?: number;
}

export type RedeemCompanionPairingOfferResult =
  | {
      readonly ok: true;
      readonly httpStatus: 200;
      readonly offer: CompanionPairingOffer;
      readonly session: CompanionSession;
    }
  | {
      readonly ok: false;
      readonly code:
        | "pairing_already_redeemed"
        | "pairing_expired"
        | "pairing_revoked"
        | "origin_mismatch"
        | "invalid_pairing_credentials"
        | "invalid_timestamp"
        | "invalid_session_id";
      readonly httpStatus: 400 | 401 | 403 | 409 | 410;
      readonly revokeIssuedSession: boolean;
      readonly revokedSessionId: string | null;
      readonly offer: CompanionPairingOffer;
      readonly message: string;
    };

export interface AuthorizeCompanionActionInput {
  readonly session: CompanionSession;
  readonly action: CompanionAction | (string & {});
  readonly attemptId: string;
  readonly requestOrigin: string;
  readonly nowMs: number;
}

export type CompanionAuthorizationFailureReason =
  | "companion_capability_forbidden"
  | "attempt_mismatch"
  | "session_expired"
  | "session_revoked";

export type AuthorizeCompanionActionResult =
  | {
      readonly allowed: true;
      readonly httpStatus: 200;
      readonly action: CompanionAllowedAction;
      readonly scopedAttemptId: string;
    }
  | {
      readonly allowed: false;
      readonly httpStatus: 403;
      readonly reason: CompanionAuthorizationFailureReason;
      readonly message: string;
    };

export interface CompanionScratchpadPage {
  readonly pageNumber: number;
  readonly objectKey: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly uploadedAtMs: number;
  readonly uploadedInRevision: number;
}

export interface CompanionScratchpadState {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly learnerId: string;
  readonly attemptId: string;
  readonly draftRevision: number;
  readonly frozen: boolean;
  readonly frozenAtMs: number | null;
  readonly frozenRevision: number | null;
  readonly pages: ReadonlyArray<CompanionScratchpadPage>;
}

export interface AppendCompanionScratchpadPageInput {
  readonly session: CompanionSession;
  readonly requestOrigin: string;
  readonly nowMs: number;
  readonly pageNumber: number;
  readonly objectKey: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly uploadedAtMs?: number;
}

export type AppendCompanionScratchpadPageResult =
  | {
      readonly ok: true;
      readonly httpStatus: 200;
      readonly draftRevision: number;
      readonly page: CompanionScratchpadPage;
      readonly state: CompanionScratchpadState;
    }
  | {
      readonly ok: false;
      readonly code:
        | "scratchpad_already_frozen"
        | "invalid_page_payload"
        | CompanionAuthorizationFailureReason;
      readonly httpStatus: 400 | 403 | 409;
      readonly state: CompanionScratchpadState;
      readonly message: string;
    };

export interface FreezeCompanionScratchpadInput {
  readonly expectedDraftRevision: number;
  readonly frozenAtMs: number;
}

export type FreezeCompanionScratchpadResult =
  | {
      readonly ok: true;
      readonly httpStatus: 200;
      readonly frozen: true;
      readonly frozenAtMs: number;
      readonly frozenRevision: number;
      readonly frozenPages: ReadonlyArray<CompanionScratchpadPage>;
      readonly state: CompanionScratchpadState;
    }
  | {
      readonly ok: false;
      readonly code: "draft_changed" | "scratchpad_already_frozen" | "invalid_freeze_input";
      readonly httpStatus: 400 | 409;
      readonly currentDraftRevision: number;
      readonly state: CompanionScratchpadState;
      readonly message: string;
    };

/* -------------------------------------------------------------------------- */
/* C. 1-Hop Bounded Cross-Course Concept Bridge                               */
/* -------------------------------------------------------------------------- */

export const BASE_PRIOR_ALPHA = 1;
export const BASE_PRIOR_BETA = 1;
export const MAX_BRIDGE_WEIGHT = 0.3;
export const MAX_BRIDGE_PSEUDO_OBSERVATIONS = 0.3;
export const MIN_DIRECT_OBSERVATIONS_FOR_BRIDGE = 3;
export const MAX_BRIDGE_PRIOR_MEAN =
  (BASE_PRIOR_ALPHA + MAX_BRIDGE_PSEUDO_OBSERVATIONS) /
  (BASE_PRIOR_ALPHA + BASE_PRIOR_BETA + MAX_BRIDGE_PSEUDO_OBSERVATIONS);
export const MIN_BRIDGE_PRIOR_MEAN =
  BASE_PRIOR_ALPHA /
  (BASE_PRIOR_ALPHA + BASE_PRIOR_BETA + MAX_BRIDGE_PSEUDO_OBSERVATIONS);

export interface CrossCourseConceptEdge {
  readonly edgeId?: string;
  readonly sourceCourseId: string;
  readonly sourceConceptId: string;
  readonly targetCourseId: string;
  readonly targetConceptId: string;
  readonly alignmentWeight: number;
  /**
   * Direct in-course success count (safe integer in `[0, sourceDirectObservationCount]`).
   * Preferred input: bridge probability is computed strictly as
   * `sourceDirectSuccessCount / sourceDirectObservationCount` without any bridged prior.
   */
  readonly sourceDirectSuccessCount?: number;
  /**
   * Direct-only mastery probability certified free of any cross-course bridged priors
   * (used only when `sourceDirectSuccessCount` is omitted, `includesBridgedPrior !== true`,
   * and `certifiedDirectObservationCount` is a safe integer `>= 3`).
   */
  readonly sourceDirectOnlyMasteryProbability?: number;
  /**
   * Safe integer count (`>= 3`) of direct in-course observations certifying
   * `sourceDirectOnlyMasteryProbability` when raw `sourceDirectSuccessCount` is omitted.
   */
  readonly certifiedDirectObservationCount?: number;
  /**
   * Legacy / mixed posterior probability that may include imported cross-course priors.
   * Never admitted directly into 1-hop bridge computation to prevent 2-hop relay.
   */
  readonly sourceMasteryProbability?: number;
  readonly includesBridgedPrior?: boolean;
  readonly sourceDirectObservationCount: number;
  readonly edgePrivacyEpoch: number;
  readonly supportingSourceIds: ReadonlyArray<string>;
  readonly hopCount?: number;
  readonly derivedFromBridge?: boolean;
}

export type CrossCourseDecoupleReason =
  | "course_sharing_disabled"
  | "privacy_epoch_mismatch"
  | "supporting_source_revoked"
  | "no_direct_source_observations"
  | "insufficient_direct_evidence"
  | "bridged_prior_contamination"
  | "multi_hop_rejected"
  | "invalid_edge_parameters";

export type CrossCourseNonDirectReason =
  | "non_direct_target_mismatch"
  | "same_course_edge";

export interface DecoupledConceptBridgeEdge {
  readonly edgeId: string;
  readonly sourceCourseId: string;
  readonly sourceConceptId: string;
  readonly targetCourseId: string;
  readonly targetConceptId: string;
  readonly reason: CrossCourseDecoupleReason;
  readonly reasons: ReadonlyArray<CrossCourseDecoupleReason>;
}

export interface IgnoredNonDirectBridgeEdge {
  readonly edgeId: string;
  readonly sourceCourseId: string;
  readonly sourceConceptId: string;
  readonly targetCourseId: string;
  readonly targetConceptId: string;
  readonly reason: CrossCourseNonDirectReason;
}

export interface AcceptedConceptBridgeEdge {
  readonly edgeId: string;
  readonly sourceCourseId: string;
  readonly sourceConceptId: string;
  readonly alignmentWeight: number;
  readonly sourceDirectOnlyMasteryProbability: number;
  readonly sourceMasteryProbability: number;
  readonly directEvidenceSource: "direct_counts" | "certified_direct_only_probability";
  readonly sourceDirectObservationCount: number;
  readonly edgePrivacyEpoch: number;
  readonly effectiveWeight: number;
  readonly deltaAlpha: number;
  readonly deltaBeta: number;
}

export interface ComputeCrossCourseWeakPriorInput<TTargetState = undefined> {
  readonly targetCourseId: string;
  readonly targetConceptId: string;
  readonly edges: ReadonlyArray<CrossCourseConceptEdge>;
  readonly coursePrivacyEpochs: Readonly<Record<string, number>>;
  readonly activeCourseSharingEnabled: Readonly<Record<string, boolean>>;
  readonly revokedSourceIds: ReadonlySet<string>;
  readonly targetInCourseState?: TTargetState;
}

export interface CrossCourseWeakPriorResult<TTargetState = undefined> {
  readonly targetCourseId: string;
  readonly targetConceptId: string;
  readonly alpha: number;
  readonly beta: number;
  readonly deltaAlpha: number;
  readonly deltaBeta: number;
  readonly equivalentObservations: number;
  readonly posteriorMean: number;
  readonly isWeakPriorOnly: true;
  readonly requiresInCourseVerification: true;
  readonly acceptedEdges: ReadonlyArray<AcceptedConceptBridgeEdge>;
  readonly decoupledEdges: ReadonlyArray<DecoupledConceptBridgeEdge>;
  readonly ignoredNonDirectEdges: ReadonlyArray<IgnoredNonDirectBridgeEdge>;
  readonly targetInCourseState: TTargetState;
}
