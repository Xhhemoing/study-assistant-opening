import "server-only";
import {
  createOpeningLearningRepository,
  createOpeningSourceRepository,
  type OpeningScope,
} from "@aistudy/database";
import { courseSourcePurposeAllows, type CourseSourcePurpose } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { ApiError } from "../../../auth/service";

export type MaterialAuthorReviewSelection = { courseId: string; sourceId: string; version: number };
export type MaterialAuthorReviewUnavailableReason =
  | "manifest_reader_disabled" | "no_import" | "unsupported_manifest_schema";

/** Server dependency, never a request grant. A future approved persistent reader
 * must check schema/revision/provenance against this current selection. This slice
 * deliberately has no raw-content/ready return path or first-answer projection. */
export type MaterialAuthorReviewManifestReader = {
  readUnavailableReason(input: MaterialAuthorReviewSelection & {
    scope: OpeningScope; sha256: string; bytes: number;
    membershipId: string; purposeRevision: string; purpose: CourseSourcePurpose | null;
  }): Promise<MaterialAuthorReviewUnavailableReason>;
};

export const disabledMaterialAuthorReviewManifestReader: MaterialAuthorReviewManifestReader = {
  async readUnavailableReason() { return "manifest_reader_disabled"; },
};

const unavailableReasons = new Set<string>(["manifest_reader_disabled", "no_import", "unsupported_manifest_schema"]);
const notFound = () => new ApiError("NOT_FOUND", "Material review not found", 404);
const conflict = () => new ApiError("CONFLICT", "Material review is no longer available", 409);

/** Call only after requireOpeningScope at the HTTP boundary. Scope/DI alone is
 * not authentication. Each call reads current facts; no reusable capability is
 * issued. The snapshot is not a promise of commit-time revocation linearization. */
export async function loadMaterialAuthorReviewHost(
  sql: Sql,
  scope: OpeningScope,
  selection: MaterialAuthorReviewSelection,
  reader: MaterialAuthorReviewManifestReader,
) {
  return sql.begin("isolation level repeatable read read only", async tx => {
    // Include archived owned courses first so foreign and missing remain opaque,
    // while the owner's archived selection is a stale-state conflict.
    const [course] = await tx`SELECT c.id,c.archived_at FROM courses c
      JOIN workspaces w ON w.id=c.workspace_id
      WHERE c.id=${selection.courseId} AND c.workspace_id=${scope.workspaceId}
        AND w.owner_user_id=${scope.ownerUserId}`;
    if (!course) throw notFound();
    if (course.archived_at !== null) throw conflict();
    // These read-only repository methods do not open nested transactions.
    const db = tx as unknown as Sql;
    await createOpeningLearningRepository(db).assertOwnedCourse(scope, selection.courseId);
    const source = await createOpeningSourceRepository(db).get(scope, selection.sourceId);
    const [membership] = await tx`SELECT id,purpose,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision
      FROM course_asset_memberships WHERE workspace_id=${scope.workspaceId}
        AND course_id=${selection.courseId} AND asset_type='source' AND asset_id=${selection.sourceId}`;
    if (!membership) throw notFound();
    const excluded = await tx`SELECT id FROM opening_privacy_exclusions
      WHERE workspace_id=${scope.workspaceId} AND source_id=${selection.sourceId} LIMIT 1`;
    const purpose = membership.purpose as CourseSourcePurpose | null;
    if (!courseSourcePurposeAllows(purpose, "teaching") || excluded.length
      || source.uploadState !== "uploaded" || source.parseState !== "ready"
      || source.version !== selection.version) throw conflict();
    const reason = await reader.readUnavailableReason({ ...selection, scope,
      sha256: source.sha256, bytes: source.bytes, membershipId: String(membership.id),
      purposeRevision: String(membership.revision), purpose });
    // External/persistent reader output is a new trust boundary. Never pass its
    // object (or an unexpected ready/raw result) through to the HTTP response.
    if (!unavailableReasons.has(reason)) throw new Error("Invalid material manifest reader result");
    return { status: "unavailable" as const, reason,
      authorReview: null, contents: [] as never[], publishable: false as const };
  });
}
