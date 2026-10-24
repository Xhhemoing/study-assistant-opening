import { createHash } from "node:crypto";
import { materialPageRole, type Scope, type StudyContextAnchor, type StudyExposureReceipt } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { readMaterialManifest } from "./opening-material-manifest";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { resolveOpeningStudyContext } from "./opening-study-context";
import { generateOpeningStudyExposure, releaseOpeningStudyExposure } from "./opening-study-exposure";

export type ConceptPreviewSelection = { text: string; start: number; end: number; originalSelection?: { text: string; start: number; end: number } };
export type ConceptPreviewReadResult =
  | { status: "restricted" | "stale" | "unavailable" }
  | { status: "read"; selection: ConceptPreviewSelection | null; anchor: StudyContextAnchor; manifestRevision: number; exposureReceipts: StudyExposureReceipt[] };

/** Reader-only: every open attempt blocks this auxiliary surface. This is NOT
 * authoritative classroom/closed-book discrimination. No client policy labels.
 * One connection holds history/source/version locks through read and delivery;
 * calling readOpeningSourceContent(sql) here would acquire a second connection,
 * exhausting a max:1 pool and splitting the manifest/content snapshot.
 */
export function createOpeningConceptPreviewRepository(sql: Sql) {
  return {
    async deliver(scope: Scope, input: { sourceId: string; sourceVersion: number; page: number; releaseKey: string },
      select: (text: string) => ConceptPreviewSelection | null): Promise<ConceptPreviewReadResult> {
      if (!/^[a-zA-Z0-9:_-]{1,119}$/.test(input.releaseKey)) throw learningError("VALIDATION", "Invalid preview delivery key");
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
        if (!owner) return { status: "unavailable" };
        const [open] = await tx`SELECT id FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND submitted_at IS NULL AND observation_id IS NULL LIMIT 1`;
        if (open) return { status: "restricted" };
        const [source] = await tx`SELECT version,parse_state FROM opening_sources
          WHERE id=${input.sourceId} AND workspace_id=${scope.workspaceId} AND upload_state='uploaded' FOR SHARE`;
        if (!source) return { status: "unavailable" };
        const [version] = await tx`SELECT availability,material_manifest,material_manifest_revision FROM opening_source_versions
          WHERE source_id=${input.sourceId} AND version=${input.sourceVersion} AND workspace_id=${scope.workspaceId} FOR SHARE`;
        if (input.sourceVersion > Number(source.version) ||
          (input.sourceVersion !== Number(source.version) && version?.availability !== "available") ||
          (version && version.availability !== "available")) return { status: "stale" };
        if (input.sourceVersion === Number(source.version) && source.parse_state !== "ready") return { status: "unavailable" };
        // Validate persisted manifests, never silently treat malformed data as public.
        let manifest: ReturnType<typeof readMaterialManifest>;
        try { manifest = readMaterialManifest(version?.material_manifest); }
        catch { throw new Error("Invalid persisted material manifest"); }
        if (manifest && !["lecture", "exercise", "exam_spec"].includes(materialPageRole(manifest, input.page))) return { status: "restricted" };
        // Exactly the reader's ordering and 20k cap, but on this locked connection.
        const chunks = await tx`SELECT left(text,20001) AS text FROM opening_source_chunks
          WHERE source_id=${input.sourceId} AND source_version=${input.sourceVersion} AND page=${input.page} ORDER BY created_at,id`;
        if (!chunks.length) return { status: "unavailable" };
        const text = chunks.map(row => String(row.text)).join("\n\n").slice(0, 20000);
        const selection = select(text);
        const anchor = await resolveOpeningStudyContext(tx, scope, { purpose: "material_read", sourceId: input.sourceId,
          sourceVersion: input.sourceVersion, page: input.page }, { sourceAccess: "human_read" });
        const manifestRevision = Number(version?.material_manifest_revision ?? 0);
        if (!selection) return { status: "read", selection: null, anchor, manifestRevision, exposureReceipts: [] };
        if (selection.start < 0 || selection.end <= selection.start || text.slice(selection.start, selection.end) !== selection.text) {
          throw learningError("VALIDATION", "Preview selection does not match source content");
        }
        const original = selection.originalSelection ?? selection;
        if (selection.text.length > 1200 || original.start < selection.start || original.end > selection.end ||
          original.end <= original.start || text.slice(original.start, original.end) !== original.text) {
          throw learningError("VALIDATION", "Original preview selection does not match context");
        }
        // Both identities matter: two terms in the same expanded paragraph are not a replay.
        const fingerprint = createHash("sha256").update(JSON.stringify([input.sourceId,input.sourceVersion,input.page,manifestRevision,
          { text: original.text, start: original.start, end: original.end },
          { text: selection.text, start: selection.start, end: selection.end }])).digest("hex");
        const prefix = `concept-preview:${input.releaseKey}:`;
        const releaseKey = `${prefix}${fingerprint}`;
        const [replay] = await tx`SELECT release_key FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId}
          AND left(release_key,${prefix.length})=${prefix} LIMIT 1`;
        if (replay && replay.release_key !== releaseKey) throw learningError("CONFLICT", "Preview delivery key belongs to another selection or material revision");
        const generated = await generateOpeningStudyExposure(tx, scope, {
          releaseKey, contextAnchor: anchor,
          origin: "material_excerpt", originReference: { type: "source", id: input.sourceId, version: String(input.sourceVersion) },
          kind: "hint", level: "hinted", supportDomain: "unknown",
        });
        const receipt = await releaseOpeningStudyExposure(tx, scope, generated.id);
        return { status: "read", selection, anchor, manifestRevision, exposureReceipts: [receipt] };
      }) as Promise<ConceptPreviewReadResult>;
    },
  };
}
