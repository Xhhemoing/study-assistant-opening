import { createHash } from "node:crypto";
import type { ExamAttempt, ExamPack, Scope } from "@aistudy/contracts";
import type { LearningSql } from "./opening-learning-facts";
import { examPackDirectorySections, legacyExamPackSections } from "./opening-exam-source-format";

type Classification = {
  kind: "metadata_only" | "legacy_untracked_source" | "unverifiable_source";
  packSourceId: string;
  sourceVersion: number | null;
};

/** Classify the actual bound original/chunks against the retained pack, never names or deployment dates. */
export async function readExamSourceExposure(db: LearningSql, scope: Scope, sprintId: string, pack: ExamPack,
  examAttemptId?: string,
): Promise<Classification | null> {
  const [row] = await db`SELECT b.binding->>'packSourceId' AS pack_source_id,s.version AS current_version,
      COALESCE(capture.source_version,s.version::text,history.version::text) AS source_version,
      s.mime,s.upload_state,s.parse_state,s.bytes,s.sha256,v.bytes AS version_bytes,v.sha256 AS version_sha256,v.availability
    FROM opening_exam_bindings b JOIN opening_exam_sprints sprint ON sprint.id=b.sprint_id
    LEFT JOIN opening_sources s ON s.id::text=b.binding->>'packSourceId' AND s.workspace_id=sprint.workspace_id
    LEFT JOIN LATERAL (SELECT a.source_versions->>(b.binding->>'packSourceId') AS source_version
      FROM opening_exam_attempt_links l JOIN opening_learning_attempts a ON a.id=l.learning_attempt_id
        AND a.workspace_id=sprint.workspace_id AND a.owner_user_id=sprint.owner_user_id
      WHERE l.sprint_id=sprint.id AND l.exam_attempt_id=${examAttemptId ?? ""} LIMIT 1) capture ON TRUE
    LEFT JOIN LATERAL (SELECT version FROM opening_source_versions
      WHERE source_id::text=b.binding->>'packSourceId' AND workspace_id=sprint.workspace_id ORDER BY version DESC LIMIT 1) history ON TRUE
    LEFT JOIN opening_source_versions v ON v.source_id::text=b.binding->>'packSourceId' AND v.workspace_id=sprint.workspace_id
      AND v.version::text=COALESCE(capture.source_version,s.version::text,history.version::text)
    WHERE sprint.id=${sprintId} AND sprint.workspace_id=${scope.workspaceId} AND sprint.owner_user_id=${scope.ownerUserId}`;
  if (!row) return null;
  const sourceVersion = row.source_version == null ? null : Number(row.source_version);
  const identity = { packSourceId: String(row.pack_source_id),
    sourceVersion: Number.isInteger(sourceVersion) && sourceVersion !== null && sourceVersion >= 0 ? sourceVersion : null };
  const unknown: Classification = { kind: "unverifiable_source", ...identity };
  // Every new directory is a new version-zero source. A later sanitized version
  // cannot prove that an earlier, still retrievable original contained no body.
  // Version zero still needs the exact directory shape and both digest checks below.
  if (identity.sourceVersion !== 0 || Number(row.current_version) !== identity.sourceVersion
    || row.mime !== "text/plain" || row.upload_state !== "uploaded" || row.parse_state !== "ready"
    || row.availability !== "available") return unknown;
  const chunks = await db`SELECT page,text FROM opening_source_chunks
    WHERE source_id=${identity.packSourceId} AND source_version=${identity.sourceVersion} ORDER BY page NULLS LAST,id`;
  if (!chunks.length || chunks.some(chunk => typeof chunk.text !== "string")) return unknown;
  const text = chunks.map(chunk => String(chunk.text)).join("\n\n"), bytes = Buffer.byteLength(text, "utf8");
  const sha256 = createHash("sha256").update(text).digest("hex");
  if (bytes !== Number(row.bytes) || bytes !== Number(row.version_bytes)
    || sha256 !== row.sha256 || sha256 !== row.version_sha256) return unknown;
  const matches = (sections: ReturnType<typeof examPackDirectorySections>) => sections.length === chunks.length
    && sections.every((section, index) => Number(chunks[index]!.page) === index + 1 && chunks[index]!.text === section.text);
  if (matches(examPackDirectorySections(pack))) return { kind: "metadata_only", ...identity };
  return matches(legacyExamPackSections(pack)) ? { kind: "legacy_untracked_source", ...identity } : unknown;
}

export function examSourceExposureCoverage(classification: Classification | null): ExamAttempt["exposureCoverage"] {
  if (!classification || classification.kind === "metadata_only" || classification.sourceVersion === null) return undefined;
  return { kind: classification.kind, packSourceId: classification.packSourceId, sourceVersion: classification.sourceVersion };
}
