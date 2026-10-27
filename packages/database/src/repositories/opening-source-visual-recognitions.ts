import { openingModelSnapshotSchema, sourceVisualRecognitionOutputSchema, type OpeningModelSnapshot, type SourceVisualRecognitionOutput } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { lockOpeningJobExecution, type OpeningJobScope } from "./opening-job-execution";
import { OpeningSourceError } from "./opening-source-errors";
import { readOpeningAiGradingLedger, readOpeningAiGradingReleasedReservation } from "./opening-ai-grading-ledger";

export type SourceVisualIdentity = { sourceId: string; sourceVersion: number; physicalPage: number };
export type SourceVisualRecord = { result: SourceVisualRecognitionOutput; modelSnapshot: OpeningModelSnapshot; operationId: string; imageObjectKey: string };
const conflict = () => new OpeningSourceError("CONFLICT", "资料或识别任务已变化，未发送或保存识别结果。");

async function assertSource(tx: Sql | TransactionSql, scope: OpeningJobScope, input: Omit<SourceVisualIdentity, "physicalPage">) {
  if (!scope.jobExecution) throw conflict();
  await lockOpeningJobExecution(tx, scope);
  const [row] = await tx`SELECT s.id FROM opening_sources s JOIN opening_jobs j ON j.id=${scope.jobExecution.id}
    WHERE s.id=${input.sourceId} AND s.workspace_id=${scope.workspaceId} AND s.version=${input.sourceVersion}
      AND s.upload_state='uploaded' AND s.mime IN ('application/pdf','image/jpeg','image/png','image/webp')
      AND j.kind='parse' AND j.payload->>'sourceId'=s.id::text
      AND (NOT (j.payload ? 'sourceVersion') OR j.payload->>'sourceVersion'=s.version::text)
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
    FOR SHARE OF s`;
  if (!row) throw conflict();
}
function validatePage(input: SourceVisualIdentity) {
  if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 0 || !Number.isSafeInteger(input.physicalPage)
    || input.physicalPage < 1 || input.physicalPage > 2000) throw new TypeError("invalid visual page identity");
}
export function createOpeningSourceVisualRecognitionsRepository(sql: Sql) {
  return {
    // Share the existing deterministic reservation-family rules. These readers
    // are scope/purpose/parent-bound; they do not modify or reopen a reservation.
    ledger: (scope: OpeningJobScope, operationId: string) => readOpeningAiGradingLedger(sql, scope, operationId),
    releasedReservation: (scope: OpeningJobScope, input: Parameters<typeof readOpeningAiGradingReleasedReservation>[2]) =>
      readOpeningAiGradingReleasedReservation(sql, scope, input),
    async assertCurrent(scope: OpeningJobScope, input: Omit<SourceVisualIdentity, "physicalPage">) {
      await sql.begin(tx => assertSource(tx, scope, input));
    },
    async read(scope: OpeningJobScope, input: SourceVisualIdentity): Promise<SourceVisualRecord | null> {
      validatePage(input);
      return sql.begin(async tx => {
        await assertSource(tx, scope, input);
        const [row] = await tx`SELECT * FROM opening_source_visual_recognitions WHERE source_id=${input.sourceId}
          AND workspace_id=${scope.workspaceId} AND source_version=${input.sourceVersion} AND physical_page=${input.physicalPage}`;
        return row ? { result: sourceVisualRecognitionOutputSchema.parse(row.result), modelSnapshot: openingModelSnapshotSchema.parse(row.model_snapshot),
          operationId: String(row.operation_id), imageObjectKey: String(row.image_object_key) } : null;
      });
    },
    async save(scope: OpeningJobScope, input: SourceVisualIdentity, record: SourceVisualRecord, signal?: AbortSignal) {
      validatePage(input);
      const result = sourceVisualRecognitionOutputSchema.parse(record.result);
      const snapshot = openingModelSnapshotSchema.parse(record.modelSnapshot);
      signal?.throwIfAborted();
      await sql.begin(async tx => {
        await assertSource(tx, scope, input);
        signal?.throwIfAborted();
        await tx`INSERT INTO opening_source_visual_recognitions(source_id,workspace_id,source_version,physical_page,result,model_snapshot,operation_id,image_object_key)
          VALUES(${input.sourceId},${scope.workspaceId},${input.sourceVersion},${input.physicalPage},${tx.json(result)},${tx.json(snapshot)},${record.operationId},${record.imageObjectKey})
          ON CONFLICT(source_id,source_version,physical_page) DO NOTHING`;
        signal?.throwIfAborted();
      });
    },
  };
}
