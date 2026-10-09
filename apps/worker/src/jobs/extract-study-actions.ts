import type { ActionCandidate, Scope } from "@aistudy/contracts";
import {
  extractStudyActionCandidates,
  type ExtractableImportChunk,
} from "@aistudy/domain";
import type { OpeningJobRecord } from "@aistudy/database";

export type ExtractStudyActionsPayload = {
  courseId: string;
  /** Owner IANA timezone for date parsing (e.g. Asia/Shanghai). */
  timeZone: string;
  /** Optional receipt filter; omit to use all authorized course-linked receipts. */
  receiptIds?: string[];
};

export type ExtractStudyActionsDeps = {
  listAuthorizedImportChunks(
    scope: Scope,
    courseId: string,
    receiptIds?: string[],
  ): Promise<ExtractableImportChunk[]>;
  /** Optional richer extractor; defaults to domain heuristic over chunk text. */
  extract?(
    chunks: readonly ExtractableImportChunk[],
    options: { timeZone: string },
  ): ActionCandidate[];
};

/**
 * P04 extract worker: authorized ImportReceipt + course chunks → pending candidates.
 * Never emits accepted tasks (auto-organize ≠ auto-commit).
 */
export function createExtractStudyActionsHandler(deps: ExtractStudyActionsDeps) {
  return async function processExtractStudyActions(
    job: OpeningJobRecord,
    payload: unknown,
  ): Promise<{ candidates: ActionCandidate[] }> {
    const body = payload as ExtractStudyActionsPayload | null;
    if (!body || typeof body.courseId !== "string" || !body.courseId) {
      throw new Error("extract-study-actions payload missing courseId");
    }
    if (typeof body.timeZone !== "string" || !body.timeZone.trim()) {
      throw new Error("extract-study-actions payload missing timeZone");
    }
    const scope: Scope = { workspaceId: job.workspaceId, ownerUserId: job.ownerUserId };
    const chunks = await deps.listAuthorizedImportChunks(
      scope,
      body.courseId,
      body.receiptIds,
    );
    const extract = deps.extract ?? extractStudyActionCandidates;
    const candidates = extract(chunks, { timeZone: body.timeZone.trim() });
    if (candidates.some((c) => c.status === "accepted")) {
      throw new Error("extract-study-actions must not emit accepted candidates");
    }
    return { candidates };
  };
}
