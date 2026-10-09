import {
  mediaSegmentCorrectionInputSchema,
  mediaSegmentSchema,
  type MediaSegment,
  type MediaSegmentCorrectionInput,
  type MediaSegmentCorrectionResult,
  type MediaSegmentsResponse,
} from "@aistudy/contracts";
import {
  OpeningS3,
  createOpeningJobRepository,
  createOpeningKnowledgeRepository,
  createOpeningPrivacyRepository,
  createOpeningSourceChunksRepository,
  createOpeningSourceRepository,
  type OpeningKnowledgeRepository,
  type OpeningStorage,
} from "@aistudy/database";
import type { Sql } from "postgres";
import type { Principal } from "../../../lib/authorization";
import { assertAuthorized, boundWorkspaceId } from "../../../lib/authorization";
import { validateMediaSegments } from "../../../../../worker/src/parsers/media-segments";

function scopeOf(p: Principal) {
  return { workspaceId: boundWorkspaceId(p), ownerUserId: p.userId };
}

function isFrameChunk(chunk: { imageObjectKey: string | null; text: string }): boolean {
  return Boolean(chunk.imageObjectKey?.trim());
}

function chunkToSegment(
  chunk: {
    id: string;
    sourceId: string;
    sourceVersion: number;
    startMs: number | null;
    endMs: number | null;
    text: string;
    imageObjectKey: string | null;
  },
  frameChunkIds: string[],
): MediaSegment | null {
  if (chunk.startMs == null || chunk.endMs == null) return null;
  if (isFrameChunk(chunk)) return null;
  return mediaSegmentSchema.parse({
    sourceId: chunk.sourceId,
    sourceVersion: chunk.sourceVersion,
    startMs: chunk.startMs,
    endMs: chunk.endMs,
    text: chunk.text,
    frameChunkIds,
    quality: "needs_check",
  });
}

/** Link timed keyframe chunks whose timestamp falls inside a transcript segment. */
export function linkFrameChunkIds(
  segment: { startMs: number; endMs: number },
  frames: Array<{ id: string; startMs: number | null }>,
): string[] {
  return frames
    .filter((frame) => frame.startMs != null && frame.startMs >= segment.startMs && frame.startMs <= segment.endMs)
    .map((frame) => frame.id);
}

/** Prefix for versioned opening source objects (final blob + frames/). */
export function openingSourceVersionPrefix(sourceId: string, version: number): string {
  return `opening/sources/${sourceId}/v${version}`;
}

/**
 * Rewrite an object key from v{from} to v{to} when it sits under the source version prefix.
 * Keys outside that layout are returned unchanged (no copy required).
 */
export function rewriteOpeningSourceVersionKey(
  key: string,
  sourceId: string,
  fromVersion: number,
  toVersion: number,
): string {
  const from = openingSourceVersionPrefix(sourceId, fromVersion);
  if (key === from || key.startsWith(`${from}/`)) {
    return openingSourceVersionPrefix(sourceId, toVersion) + key.slice(from.length);
  }
  return key;
}

export type VersionCopyStorage = Pick<OpeningStorage, "finalKey" | "copyObject">;

/**
 * Copy finalKey(id, from) → finalKey(id, to) and rewrite/copy forwarded frame keys
 * under opening/sources/{id}/v{n}/… so the bumped version resolves in object storage.
 */
export async function copyOpeningSourceVersionObjects(
  storage: VersionCopyStorage,
  input: {
    sourceId: string;
    fromVersion: number;
    toVersion: number;
    frameObjectKeys: readonly string[];
  },
): Promise<{ finalFrom: string; finalTo: string; frames: Array<{ from: string; to: string }> }> {
  const finalFrom = storage.finalKey(input.sourceId, input.fromVersion);
  const finalTo = storage.finalKey(input.sourceId, input.toVersion);
  await storage.copyObject(finalFrom, finalTo);

  const frames: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const fromKey of input.frameObjectKeys) {
    const toKey = rewriteOpeningSourceVersionKey(
      fromKey,
      input.sourceId,
      input.fromVersion,
      input.toVersion,
    );
    frames.push({ from: fromKey, to: toKey });
    if (fromKey === toKey) continue;
    const dedupe = `${fromKey}=>${toKey}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    await storage.copyObject(fromKey, toKey);
  }
  return { finalFrom, finalTo, frames };
}

function defaultOpeningStorage(): OpeningStorage {
  return new OpeningS3({
    endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: process.env.S3_BUCKET ?? "aistudy",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  });
}

export type OpeningMediaSegmentsServiceDeps = {
  /** K01 knowledge invalidate + optional full-course rebuild after correction (inject for unit tests). */
  knowledge?: Pick<OpeningKnowledgeRepository, "markNeedsCheckForSources" | "enqueueRebuild">;
  /** Source lookup override (tests). */
  sources?: Pick<ReturnType<typeof createOpeningSourceRepository>, "get">;
  /** Job receipt overrides (tests). */
  jobs?: Pick<ReturnType<typeof createOpeningJobRepository>, "createOnce" | "claim" | "finish">;
  /** Privacy epoch override (tests). */
  privacy?: Pick<ReturnType<typeof createOpeningPrivacyRepository>, "getWorkspaceEpoch">;
  /**
   * Test seam: replace the CAS bump + object-copy transaction.
   * Production path uses sql.begin; inject to unit-test post-commit knowledge invalidate ordering.
   */
  commitCorrectionBump?: (input: {
    scope: { workspaceId: string; ownerUserId: string };
    sourceId: string;
    expectedVersion: number;
    validated: MediaSegment[];
  }) => Promise<number>;
};

/**
 * Server-owned media segments: timing comes from stored SourceChunks, never from the model.
 * Audio-only transcripts never claim visual/board understanding.
 */
export function createOpeningMediaSegmentsService(
  sql: Sql,
  storage: OpeningStorage = defaultOpeningStorage(),
  deps: OpeningMediaSegmentsServiceDeps = {},
) {
  const sources = deps.sources ?? createOpeningSourceRepository(sql);
  const chunks = createOpeningSourceChunksRepository(sql);
  const jobs = deps.jobs ?? createOpeningJobRepository(sql);
  const privacy = deps.privacy ?? createOpeningPrivacyRepository(sql);
  const knowledge =
    deps.knowledge ?? createOpeningKnowledgeRepository(sql);

  return {
    async listSegments(principal: Principal, sourceId: string): Promise<MediaSegmentsResponse> {
      assertAuthorized(principal, "source.read", { type: "workspace", workspaceId: boundWorkspaceId(principal) });
      const scope = scopeOf(principal);
      const source = await sources.get(scope, sourceId);
      const listed = await chunks.listChunks(scope, sourceId);
      const frames = listed.filter(isFrameChunk);
      const segments = listed
        .map((chunk) =>
          chunkToSegment(
            chunk,
            linkFrameChunkIds(
              { startMs: chunk.startMs ?? 0, endMs: chunk.endMs ?? 0 },
              frames.map((f) => ({ id: f.id, startMs: f.startMs })),
            ),
          ),
        )
        .filter((s): s is MediaSegment => s != null);
      const durationMs =
        segments.length > 0 ? Math.max(...segments.map((s) => s.endMs)) : null;
      return {
        sourceId: source.id,
        sourceVersion: source.version,
        durationMs,
        segments,
        claimsVisualUnderstanding: false,
      };
    },

    async applyCorrections(
      principal: Principal,
      sourceId: string,
      raw: unknown,
    ): Promise<MediaSegmentCorrectionResult> {
      assertAuthorized(principal, "source.complete", {
        type: "workspace",
        workspaceId: boundWorkspaceId(principal),
      });
      const scope = scopeOf(principal);
      const source = await sources.get(scope, sourceId);
      const input: MediaSegmentCorrectionInput = mediaSegmentCorrectionInputSchema.parse(raw);
      if (input.expectedVersion !== source.version) {
        throw new Error("CONFLICT: source version mismatch");
      }
      const durationMs =
        input.durationMs ??
        (input.segments.length > 0 ? Math.max(...input.segments.map((s) => s.endMs)) : 0);

      // Force server-owned source/version on every segment (pre-bump binding for validation).
      const normalized = input.segments.map((segment) => ({
        ...segment,
        sourceId: source.id,
        sourceVersion: source.version,
        quality: "checked" as const,
      }));
      const validated = validateMediaSegments(normalized, durationMs);
      const privacyEpoch = await privacy.getWorkspaceEpoch(scope);

      // Source-side version bump + segment replacement. Keeps prior version chunks intact.
      // Object-storage bytes are copied v{n}→v{n+1} (finalKey + forwarded frames) inside the
      // transaction before commit, matching completeUpload's beforeComplete pattern.
      // Knowledge invalidate runs AFTER this commit (see below) so a markNeedsCheck failure
      // cannot roll back a successful source version bump.
      const bumped = deps.commitCorrectionBump
        ? await deps.commitCorrectionBump({
            scope,
            sourceId: source.id,
            expectedVersion: input.expectedVersion,
            validated,
          })
        : await sql.begin(async (tx) => {
            const rows = await tx`
              SELECT id, version, bytes, sha256, upload_state
              FROM opening_sources
              WHERE id = ${source.id} AND workspace_id = ${scope.workspaceId}
              FOR UPDATE
            `;
            const row = rows[0] as Record<string, unknown> | undefined;
            if (!row) throw new Error("source not found");
            if (Number(row.version) !== input.expectedVersion || row.upload_state !== "uploaded") {
              throw new Error("CONFLICT: source version mismatch");
            }
            const newVersion = Number(row.version) + 1;

            const prior = await tx`
              SELECT page, slide_label, start_ms, end_ms, text, image_object_key
              FROM opening_source_chunks
              WHERE source_id = ${source.id} AND source_version = ${input.expectedVersion}
                AND image_object_key IS NOT NULL AND image_object_key <> ''
              ORDER BY page NULLS LAST, created_at
            `;
            const frameObjectKeys = (prior as Array<Record<string, unknown>>).map((f) =>
              String(f.image_object_key),
            );
            const copied = await copyOpeningSourceVersionObjects(storage, {
              sourceId: source.id,
              fromVersion: input.expectedVersion,
              toVersion: newVersion,
              frameObjectKeys,
            });

            await tx`
              UPDATE opening_sources
              SET version = ${newVersion}, parse_state = 'ready', error = NULL, updated_at = now()
              WHERE id = ${source.id} AND workspace_id = ${scope.workspaceId} AND version = ${input.expectedVersion}
            `;
            await tx`
              INSERT INTO opening_source_versions(source_id, version, workspace_id, bytes, sha256, availability)
              VALUES (
                ${source.id},
                ${newVersion},
                ${scope.workspaceId},
                ${Number(row.bytes)},
                ${String(row.sha256)},
                'available'
              )
              ON CONFLICT (source_id, version) DO NOTHING
            `;

            let page = 1;
            for (const segment of validated) {
              await tx`
                INSERT INTO opening_source_chunks (
                  source_id, source_version, page, slide_label, start_ms, end_ms, text, image_object_key
                ) VALUES (
                  ${source.id}, ${newVersion}, ${page}, NULL,
                  ${segment.startMs}, ${segment.endMs}, ${segment.text}, NULL
                )
              `;
              page += 1;
            }
            for (const frame of prior) {
              const f = frame as Record<string, unknown>;
              const fromKey = String(f.image_object_key);
              const toKey =
                copied.frames.find((entry) => entry.from === fromKey)?.to ??
                rewriteOpeningSourceVersionKey(fromKey, source.id, input.expectedVersion, newVersion);
              await tx`
                INSERT INTO opening_source_chunks (
                  source_id, source_version, page, slide_label, start_ms, end_ms, text, image_object_key
                ) VALUES (
                  ${source.id}, ${newVersion}, ${page}, ${f.slide_label as string | null},
                  ${f.start_ms == null ? null : Number(f.start_ms)},
                  ${f.end_ms == null ? null : Number(f.end_ms)},
                  ${String(f.text)},
                  ${toKey}
                )
              `;
              page += 1;
            }
            return newVersion;
          });

      // V01→K01: source-level needs_check for courses whose snapshot lists this source in
      // source_versions. K01 has no time-range-scoped invalidate API, so we mark the whole
      // snapshot graph needs_check (not only the corrected interval). Order: source bump
      // commits first; if this mark fails we surface the error while leaving the bumped
      // source version consistent.
      const marked = await knowledge.markNeedsCheckForSources(scope, [source.id]);

      // Best-effort full-course enqueueRebuild for every course that listed this source.
      // Rebuild is FULL-COURSE (build-course-knowledge), NOT time-scoped to the corrected
      // interval — same limitation as needs_check. Failure must not roll back the committed
      // source bump or undo needs_check; swallow and continue to the correction job receipt.
      const rebuildClientKey = `media-correction:${source.id}:v${bumped}`;
      for (const courseId of marked.courseIds) {
        try {
          await knowledge.enqueueRebuild(scope, courseId, { clientKey: rebuildClientKey });
        } catch {
          // best-effort: needs_check already applied; UI/K01 rebuild remains available
        }
      }

      // Capability-interfaces: corrections return { jobId }. No new job kind (0050 is
      // parse-media only); record an idempotent succeeded receipt without outbox dispatch
      // so a later parse-media run cannot overwrite the corrected segments.
      const jobKey = `media-corrections:${source.id}:${input.clientKey}`;
      const payload = {
        sourceId: source.id,
        correctedVersion: bumped,
        mode: "segments-correction" as const,
        segmentCount: validated.length,
      };
      const job = await jobs.createOnce(scope, {
        key: jobKey,
        kind: "parse-media",
        payload,
        privacyEpoch,
      });
      // finish() only transitions from running — claim the receipt then mark succeeded.
      // No outbox row: worker must not re-run parse-media over the corrected segments.
      if (job.state === "queued") {
        const claimed = await jobs.claim(job.id);
        if (claimed) {
          await jobs.finish(claimed.id, "succeeded", {
            ...payload,
            claimsVisualUnderstanding: false,
          });
        }
      }
      return { jobId: job.id };
    },
  };
}
