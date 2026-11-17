import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import {
  materialImportBindingInputSchema, computeMaterialImportContentHashes, sha256HexSchema,
  type MaterialImportBindingInput, type OpeningMaterialPurposePin,
} from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { assertIdentitySessionForWriteInTx, type ServerSessionWriteCredential } from "./identity";
import { createOpeningCourseReadySourcesRepository } from "./opening-course-ready-sources";
import { learningError, lockLearningOwner, lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";

import { bindingSchema, manifestSchema, purposePinSchema, validateRetainedMaterialImportState,
  type OpeningMaterialImportBinding } from "./opening-material-import-state";
export type { OpeningMaterialImportBinding } from "./opening-material-import-state";
export type OpeningMaterialImportReceipt = {
  mappingId: string; manifestRevision: number; sourceId: string; sourceVersion: number;
  sourceSha256: string; questionContentSha256: string; answerContentSha256: string;
  reviewedAt: string; duplicate: boolean;
};
type Selection = { courseId: string; purposePin: OpeningMaterialPurposePin };
type Selector = Selection & { sourceId: string; sourceVersion: number; mappingId: string; expectedManifestRevision: number };
export type OpeningMaterialImportBindingsRepository = {
  /** Server scope/pin are NOT authentication. No HTTP principal or first-answer projection here. */
  accept(scope: OpeningScope, selection: Selection, input: unknown): Promise<OpeningMaterialImportReceipt>;
  /** PRIVATE raw answer-bearing reader. Locks current facts in the supplied actual RC transaction. */
  readCurrent(scope: OpeningScope, selector: Selector, tx?: TransactionSql): Promise<
    { availability: "available"; binding: OpeningMaterialImportBinding } | { availability: "unavailable"; reason: "binding_missing" }
  >;
};
function conflict(message: string): never { throw learningError("CONFLICT", message); }
type MaterialSource = { id: string; version: number; sha256: string; bytes: number | string };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type PreparedImport = {
  input: MaterialImportBindingInput;
  hashes: Awaited<ReturnType<typeof computeMaterialImportContentHashes>>;
};
async function prepareImport(raw: unknown): Promise<PreparedImport> {
  const input = materialImportBindingInputSchema.parse(raw);
  const hashes = await computeMaterialImportContentHashes(input, sha256);
  return { input, hashes };
}

async function currentManifest(tx: TransactionSql, scope: OpeningScope, row: Parameters<typeof validateRetainedMaterialImportState>[0], sourceId: string, version: number) {
  // lockCurrent already holds this counter FOR UPDATE; read the actual locked fence.
  const [history] = await tx`SELECT revision FROM opening_workspace_history_revisions
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  const manifest = validateRetainedMaterialImportState(row, sourceId, version, Number(history?.revision));
  if (manifest && (manifest.restoredFromBackup || row.material_reviewed_by == null
    || manifest.bindings[manifest.bindings.length - 1]!.reviewedBy !== scope.ownerUserId)) conflict("retained audit is not current review authority");
  return manifest;
}

async function assertLocators(tx: TransactionSql, input: MaterialImportBindingInput) {
  const ids = [...new Set([input.question.locator.chunkId, input.answer.locator.chunkId])].sort();
  const rows = await tx`SELECT id,page,text FROM opening_source_chunks
    WHERE source_id=${input.sourceId} AND source_version=${input.sourceVersion} AND id=ANY(${ids}::uuid[])
    ORDER BY id FOR SHARE`;
  for (const part of [input.question, input.answer]) {
    const chunk = rows.find(row => row.id === part.locator.chunkId);
    if (!chunk || (chunk.page == null ? null : Number(chunk.page)) !== part.locator.physicalPage
      || part.locator.textRange.end > String(chunk.text).length) conflict("locator does not resolve to actual chunk/page/range");
    // Manual transcription is an assertion by the owner, not byte equality or a correctness proof.
    // The original range must nevertheless refer to real, nonblank text (no guessed physical pages).
    const text = String(chunk.text).slice(part.locator.textRange.start, part.locator.textRange.end);
    if (!text.trim()) conflict("locator range has no source text");
  }
}

function createMaterialImportOperations(sql: Sql) {
  const purposes = createOpeningCourseReadySourcesRepository(sql);
  async function lockCurrent(tx: TransactionSql, scope: OpeningScope, selection: Selection, sourceId: string, version: number) {
    // Never admit a historical snapshot as current write/use authority; no implicit serialization retries.
    const [isolation] = await tx`SHOW transaction_isolation`;
    if (isolation?.transaction_isolation !== "read committed") conflict("current read-committed transaction required");
    await lockWorkspaceLearningHistory(tx, scope);
    await lockLearningOwner(tx, scope);
    const pin = purposePinSchema.safeParse(selection.purposePin);
    if (!pin.success || pin.data.courseId !== selection.courseId || pin.data.sources[0]!.sourceId !== sourceId
      || pin.data.sources[0]!.sourceVersion !== version) conflict("one course-scoped teaching purpose pin required");
    const course = await tx`SELECT id FROM courses WHERE id=${selection.courseId} AND workspace_id=${scope.workspaceId}
      AND archived_at IS NULL FOR SHARE`;
    if (!course.length) conflict("course unavailable");
    const [source] = await tx<MaterialSource[]>`SELECT id,version,sha256,bytes FROM opening_sources s
      WHERE id=${sourceId} AND workspace_id=${scope.workspaceId} AND upload_state='uploaded' AND parse_state='ready'
        AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
      FOR SHARE OF s`;
    if (!source || Number(source.version) !== version || !sha256HexSchema.safeParse(source.sha256).success) conflict("source unavailable or version changed");
    // Actual write/read transaction, membership row locks survive to its commit. Sources precede membership.
    await purposes.assertMaterialPurposePin(scope, pin.data, tx);
    return { source: source!, pin: pin.data };
  }
  async function lockVersion(tx: TransactionSql, scope: OpeningScope, source: MaterialSource, create: boolean) {
    if (create) await tx`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      VALUES(${source.id},${source.version},${scope.workspaceId},${source.bytes},${source.sha256},'available')
      ON CONFLICT(source_id,version) DO NOTHING`;
    const [row] = await tx`SELECT *,to_char(material_reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS material_reviewed_at
      FROM opening_source_versions WHERE source_id=${source.id} AND version=${source.version} FOR UPDATE`;
    if (!row) return null;
    if (row.workspace_id !== scope.workspaceId || row.availability !== "available" || Number(row.bytes) !== Number(source.bytes)
      || String(row.sha256).toLowerCase() !== String(source.sha256).toLowerCase()) conflict("retained source version unavailable or changed");
    return row!;
  }
  function receipt(binding: OpeningMaterialImportBinding, duplicate: boolean): OpeningMaterialImportReceipt {
    return { mappingId: binding.input.mappingId, manifestRevision: binding.acceptedRevision,
      sourceId: binding.input.sourceId, sourceVersion: binding.input.sourceVersion, sourceSha256: binding.input.sourceSha256,
      questionContentSha256: binding.questionContentSha256, answerContentSha256: binding.answerContentSha256,
      reviewedAt: binding.reviewedAt, duplicate };
  }
  return {
    async appendPreparedInTx(tx: TransactionSql, scope: OpeningScope, selection: Selection, prepared: PreparedImport): Promise<OpeningMaterialImportReceipt> {
      const { input, hashes } = prepared;
      const { source, pin } = await lockCurrent(tx, scope, selection, input.sourceId, input.sourceVersion);
      if (String(source.sha256).toLowerCase() !== input.sourceSha256) conflict("source SHA changed");
      const row = (await lockVersion(tx, scope, source, true))!;
      const revision = Number(row.material_manifest_revision);
      const manifest = await currentManifest(tx, scope, row, input.sourceId, input.sourceVersion);
      await assertLocators(tx, input);
      const previous = manifest?.bindings.find(binding => binding.input.mappingId === input.mappingId);
      if (previous) {
        if (previous.acceptedRevision !== revision || previous.reviewedBy !== scope.ownerUserId
          || previous.courseId !== selection.courseId || !isDeepStrictEqual(previous.input, input)
          || !isDeepStrictEqual(previous.purposePin, pin)
          || previous.questionContentSha256 !== hashes.questionContentSha256 || previous.answerContentSha256 !== hashes.answerContentSha256) {
          conflict("mapping identity was already accepted with different payload, facts or revision");
        }
        return receipt(previous, true);
      }
      if (revision !== input.expectedManifestRevision || revision === 2_147_483_647) conflict("manifest revision changed or exhausted");
      const [clock] = await tx`SELECT clock_timestamp() AS reviewed_at`;
      const binding = bindingSchema.parse({ input, courseId: selection.courseId, purposePin: pin, ...hashes,
        acceptedFromRevision: revision, acceptedRevision: revision + 1, reviewedBy: scope.ownerUserId,
        reviewedAt: new Date(clock!.reviewed_at).toISOString(), historyRevision: await nextWorkspaceLearningHistoryRevision(tx, scope) });
      const next = manifestSchema.parse({ schemaVersion: 1, revision: revision + 1, bindings: [...(manifest?.bindings ?? []), binding] });
      const written = await tx`UPDATE opening_source_versions SET material_manifest=${tx.json(next)},
        material_manifest_revision=${revision + 1},material_reviewed_by=${scope.ownerUserId},material_reviewed_at=${binding.reviewedAt}
        WHERE source_id=${input.sourceId} AND version=${input.sourceVersion} AND workspace_id=${scope.workspaceId}
          AND availability='available' AND material_manifest_revision=${revision} RETURNING version`;
      if (written.length !== 1) conflict("manifest compare-and-swap failed");
      return receipt(binding, false);
    },
    async readCurrent(scope: OpeningScope, selector: Selector, tx?: TransactionSql) {
      const read = async (db: TransactionSql) => {
        const { source, pin } = await lockCurrent(db, scope, selector, selector.sourceId, selector.sourceVersion);
        const row = await lockVersion(db, scope, source, false);
        if (!row) return { availability: "unavailable", reason: "binding_missing" } as const;
        const revision = Number(row.material_manifest_revision);
        if (revision !== selector.expectedManifestRevision) conflict("manifest revision changed");
        const manifest = await currentManifest(db, scope, row, selector.sourceId, selector.sourceVersion);
        const binding = manifest?.bindings.find(value => value.input.mappingId === selector.mappingId);
        if (!binding) return { availability: "unavailable", reason: "binding_missing" } as const;
        if (binding.courseId !== selector.courseId || binding.reviewedBy !== scope.ownerUserId
          || !isDeepStrictEqual(binding.purposePin, pin) || binding.input.sourceSha256 !== String(source.sha256).toLowerCase()) conflict("binding facts changed");
        const hashes = await computeMaterialImportContentHashes(binding.input, sha256);
        if (binding.questionContentSha256 !== hashes.questionContentSha256 || binding.answerContentSha256 !== hashes.answerContentSha256) conflict("persisted content digest mismatch");
        await assertLocators(db, binding.input);
        return { availability: "available", binding } as const;
      };
      return tx ? read(tx) : sql.begin("isolation level read committed", read) as ReturnType<typeof read>;
    },
  };
}

export function createOpeningMaterialImportBindingsRepository(sql: Sql): OpeningMaterialImportBindingsRepository {
  const operations = createMaterialImportOperations(sql);
  return {
    async accept(scope, selection, raw) {
      // Preserve the public boundary: parse/hash before exactly one RC begin.
      const prepared = await prepareImport(raw);
      return sql.begin("isolation level read committed", tx => operations.appendPreparedInTx(tx, scope, selection, prepared)) as Promise<OpeningMaterialImportReceipt>;
    },
    readCurrent: operations.readCurrent,
  };
}

/** Source-module-only, NOT authentication. Caller owns the actual RC tx and rollback. */
export function createOpeningMaterialImportAcceptInTx(sql: Sql): (
  tx: TransactionSql, scope: OpeningScope, selection: Selection, raw: unknown,
) => Promise<OpeningMaterialImportReceipt> {
  const operations = createMaterialImportOperations(sql);
  return async function acceptInTx(tx, scope, selection, raw) {
    const prepared = await prepareImport(raw);
    return operations.appendPreparedInTx(tx, scope, selection, prepared);
  };
}

/**
 * Source-module-only interactive-session composition; no production consumer.
 * Credential shape is not signature proof: a trusted server raw reader is still
 * required. No second scope/job/callback. Native errors must abort the outer tx.
 * Final check covers duplicate too; its DB clock cut is NOT commit stability.
 */
export function createOpeningMaterialImportSessionAcceptInTx(sql: Sql): (
  tx: TransactionSql, credential: ServerSessionWriteCredential, selection: Selection, raw: unknown,
) => Promise<OpeningMaterialImportReceipt> {
  const acceptInTx = createOpeningMaterialImportAcceptInTx(sql);
  return async function sessionAcceptInTx(tx, credential, selection, raw) {
    const localCredential: ServerSessionWriteCredential = {
      userId: credential.userId, workspaceId: credential.workspaceId,
      sessionId: credential.sessionId, tokenHash: credential.tokenHash,
      jwtExpiresAtSeconds: credential.jwtExpiresAtSeconds,
    };
    const scope: OpeningScope = { ownerUserId: localCredential.userId, workspaceId: localCredential.workspaceId };
    const [isolation] = await tx`SHOW transaction_isolation`;
    if (isolation?.transaction_isolation !== "read committed") conflict("current read-committed transaction required");
    await lockWorkspaceLearningHistory(tx, scope);
    await lockLearningOwner(tx, scope);
    await assertIdentitySessionForWriteInTx(tx, localCredential);
    const result = await acceptInTx(tx, scope, selection, raw);
    await assertIdentitySessionForWriteInTx(tx, localCredential);
    return result;
  };
}
