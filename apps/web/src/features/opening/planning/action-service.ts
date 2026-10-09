import {
  actionCandidateSchema,
  actionDigestSchema,
  type ActionCandidate,
  type ActionDigest,
  type PlanDraft,
  type Scope,
} from "@aistudy/contracts";
import {
  applySourceRevision,
  assertDigestHasNoMasteryPercentage,
  blockerToDigestCandidate,
  buildActionDigest,
  deltaTaskIdsForRevision,
  extractStudyActionCandidates,
  type DigestActionCandidate,
  type ExtractableImportChunk,
} from "@aistudy/domain";
import type { Sql } from "postgres";
import { z } from "zod";
import { ApiError } from "../../auth/service";

/**
 * Narrow persistence seam for P04.
 * Pending candidates come from AI `extractStudyActionCandidates` / worker
 * `extract-study-actions` job results (migration 0051 job kind on opening_jobs).
 * Accept/reject overlays: production uses Data `createOpeningActionDigestDecisionsRepository`
 * (migration 0052); inject `createInMemoryActionCandidateStore` in unit tests.
 */
export type ActionCandidateStore = {
  list(scope: Scope): Promise<ActionCandidate[]>;
  upsert(scope: Scope, candidate: ActionCandidate): Promise<ActionCandidate>;
  replaceAll?(scope: Scope, candidates: ActionCandidate[]): Promise<void>;
};

/** Source of pending ActionCandidate[] from extract-study-actions. */
export type ExtractedActionCandidateSource = {
  listPending(scope: Scope): Promise<ActionCandidate[]>;
};

export type ActionDigestPlanAdapter = {
  /**
   * Re-plan adapter for source revision after accept.
   * Only schedules delta task ids — never silently rewrite unchanged blocks
   * or change T03/P02 confirmation semantics of existing accept/reject routes.
   */
  proposeDeltaDraft(input: {
    scope: Scope;
    date: string;
    taskIds: string[];
    clientKey: string;
  }): Promise<PlanDraft | null>;
};

export type ActionDigestBlockerSource = {
  listBlockers(scope: Scope): Promise<
    Array<{
      id: string;
      nodeId: string;
      kind: string;
      reason: string;
      evidenceIds: string[];
      minutes?: number;
      priority?: number;
      dueAt?: string | null;
    }>
  >;
};

export const actionDigestDecisionSchema = z
  .object({
    decision: z.enum(["accept", "reject"]),
    candidateId: z.string().uuid(),
    clientKey: z.string().min(8).max(200),
  })
  .strict();

export type ActionDigestDecision = z.infer<typeof actionDigestDecisionSchema>;

const extractJobResultSchema = z
  .object({
    candidates: z.array(actionCandidateSchema),
  })
  .passthrough();

function toDigestCandidate(candidate: ActionCandidate): DigestActionCandidate {
  return {
    id: candidate.id,
    dedupeKey: candidate.dedupeKey,
    title: candidate.title,
    minutes: candidate.minutes,
    dueAt: candidate.dueAt,
    priority: candidate.priority,
    sourceIds: candidate.sourceIds,
    status: candidate.status,
    needsConfirmation: candidate.needsConfirmation,
  };
}

function fromDigestCandidate(candidate: DigestActionCandidate): ActionCandidate {
  return actionCandidateSchema.parse(candidate);
}

/** Apply accept/reject overlays onto extracted pending rows (by id, then dedupeKey). */
export function applyDecisionOverlay(
  extracted: readonly ActionCandidate[],
  decisions: readonly ActionCandidate[],
): ActionCandidate[] {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const byKey = new Map<string, ActionCandidate>();
  for (const d of decisions) {
    if (d.status === "rejected" || d.status === "accepted" || d.status === "superseded") {
      byKey.set(d.dedupeKey, d);
    }
  }
  const seenKeys = new Set<string>();
  const out: ActionCandidate[] = [];
  for (const row of extracted) {
    const byExact = byId.get(row.id);
    const byDedupe = byKey.get(row.dedupeKey);
    const overlay = byExact ?? byDedupe;
    if (overlay && overlay.status !== "pending") {
      out.push({
        ...row,
        status: overlay.status,
        needsConfirmation: false,
      });
      seenKeys.add(row.dedupeKey);
      continue;
    }
    out.push(row);
    seenKeys.add(row.dedupeKey);
  }
  // Keep decision-only rows (e.g. superseded history) for digest resolve rules.
  for (const d of decisions) {
    if (seenKeys.has(d.dedupeKey) && byId.has(d.id)) continue;
    if (!extracted.some((e) => e.id === d.id)) out.push(d);
  }
  return out;
}

/** In-memory decision / seed store for unit tests only. */
export function createInMemoryActionCandidateStore(
  seed: ActionCandidate[] = [],
): ActionCandidateStore {
  const byWorkspace = new Map<string, Map<string, ActionCandidate>>();
  const bucket = (scope: Scope) => {
    const key = `${scope.workspaceId}:${scope.ownerUserId}`;
    let map = byWorkspace.get(key);
    if (!map) {
      map = new Map(seed.map((c) => [c.id, actionCandidateSchema.parse(c)]));
      byWorkspace.set(key, map);
    }
    return map;
  };
  return {
    async list(scope) {
      return [...bucket(scope).values()].map((c) => actionCandidateSchema.parse(c));
    },
    async upsert(scope, candidate) {
      const parsed = actionCandidateSchema.parse(candidate);
      bucket(scope).set(parsed.id, parsed);
      return parsed;
    },
    async replaceAll(scope, candidates) {
      const map = bucket(scope);
      map.clear();
      for (const candidate of candidates) {
        const parsed = actionCandidateSchema.parse(candidate);
        map.set(parsed.id, parsed);
      }
    },
  };
}

/**
 * Read pending ActionCandidate[] from succeeded extract-study-actions jobs.
 * Uses existing opening_jobs (kind allowed by migration 0051) — no new tables.
 */
export function createExtractJobCandidateSource(
  sql: Sql,
): ExtractedActionCandidateSource {
  return {
    async listPending(scope) {
      const rows = await sql`
        SELECT result FROM opening_jobs
        WHERE workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}
          AND kind = 'extract-study-actions'
          AND state = 'succeeded'
          AND result IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 20
      `;
      const byId = new Map<string, ActionCandidate>();
      for (const row of rows) {
        const parsed = extractJobResultSchema.safeParse(row.result);
        if (!parsed.success) continue;
        for (const candidate of parsed.data.candidates) {
          if (candidate.status !== "pending") continue;
          if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
        }
      }
      return [...byId.values()];
    },
  };
}

/** Sync helper: run domain extractor (same shape the worker uses). */
export function candidatesFromImportChunks(
  chunks: readonly ExtractableImportChunk[],
  options: { timeZone: string; createId?: () => string },
): ActionCandidate[] {
  return extractStudyActionCandidates(chunks, options);
}

export function createOpeningActionService(deps: {
  /** Decision overlay + optional seed candidates (tests). */
  store: ActionCandidateStore;
  /** Pending candidates from extract-study-actions job results / AI extractor. */
  extracted?: ExtractedActionCandidateSource;
  blockers?: ActionDigestBlockerSource;
  planAdapter?: ActionDigestPlanAdapter;
}) {
  async function loadCandidates(scope: Scope): Promise<ActionCandidate[]> {
    const extracted = deps.extracted ? await deps.extracted.listPending(scope) : [];
    const decisions = await deps.store.list(scope);
    // Prefer extract-study-actions pending rows + decision overlay; fall back to
    // store seed when no extract source has produced candidates yet (unit tests).
    const base =
      extracted.length > 0
        ? applyDecisionOverlay(extracted, decisions)
        : decisions;
    const blockers = deps.blockers ? await deps.blockers.listBlockers(scope) : [];
    const mapped = blockers.map((blocker) =>
      fromDigestCandidate(blockerToDigestCandidate(blocker)),
    );
    return [...base, ...mapped];
  }

  async function getDigest(scope: Scope): Promise<ActionDigest> {
    const candidates = await loadCandidates(scope);
    const view = buildActionDigest(candidates.map(toDigestCandidate));
    for (const row of view.primary) {
      assertDigestHasNoMasteryPercentage({ ...row } as Record<string, unknown>);
    }
    return actionDigestSchema.parse({
      primary: view.primary.map(fromDigestCandidate),
      pendingConfirmationCount: view.pendingConfirmationCount,
    });
  }

  return {
    getDigest,

    /**
     * Accept / reject on the digest surface (overlay only).
     * Never auto-creates tasks or accepts plans — T03 / P02 stay on their routes.
     */
    async decide(
      scope: Scope,
      raw: unknown,
    ): Promise<{ candidate: ActionCandidate; digest: ActionDigest }> {
      const input = actionDigestDecisionSchema.parse(raw);
      const candidates = await loadCandidates(scope);
      const current = candidates.find((c) => c.id === input.candidateId);
      if (!current) {
        throw new ApiError("NOT_FOUND", "action candidate not found", 404);
      }
      if (current.status !== "pending") {
        throw new ApiError("CONFLICT", "action candidate is not pending", 409);
      }
      const nextStatus = input.decision === "accept" ? "accepted" : "rejected";
      const updated = await deps.store.upsert(scope, {
        ...current,
        status: nextStatus,
        needsConfirmation: false,
      });
      return { candidate: updated, digest: await getDigest(scope) };
    },

    /**
     * Source-revision adapter for T03-shaped candidates.
     * Supersedes old pending rows; does not change discard/accept route contracts.
     */
    async reviseSourceCandidate(
      scope: Scope,
      revised: ActionCandidate,
    ): Promise<{ candidates: ActionCandidate[]; digest: ActionDigest }> {
      const existing = await loadCandidates(scope);
      const next = applySourceRevision(
        existing.map(toDigestCandidate),
        toDigestCandidate(revised),
      ).map(fromDigestCandidate);
      if (deps.store.replaceAll) {
        await deps.store.replaceAll(scope, next);
      } else {
        for (const candidate of next) {
          await deps.store.upsert(scope, candidate);
        }
      }
      return { candidates: next, digest: await getDigest(scope) };
    },

    async proposeDeltaAfterRevision(input: {
      scope: Scope;
      date: string;
      previouslyAcceptedTaskIds: string[];
      revisedCandidateTaskIds: string[];
      clientKey: string;
    }): Promise<PlanDraft | null> {
      if (!deps.planAdapter) return null;
      const taskIds = deltaTaskIdsForRevision({
        previouslyAcceptedTaskIds: input.previouslyAcceptedTaskIds,
        revisedCandidateTaskIds: input.revisedCandidateTaskIds,
      });
      if (taskIds.length === 0) return null;
      return deps.planAdapter.proposeDeltaDraft({
        scope: input.scope,
        date: input.date,
        taskIds,
        clientKey: input.clientKey,
      });
    },
  };
}

export type OpeningActionService = ReturnType<typeof createOpeningActionService>;
