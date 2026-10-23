import { photoQuestionRecognitionInputSchema, photoQuestionRecognitionProposalSchema, type PhotoQuestionRecognitionInput, type PhotoQuestionRecognitionProposal, type PhotoQuestionRecognitionResponse, type Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { lockOpeningJobExecution, type OpeningJobScope } from "./opening-job-execution";

const kind = "recognize-photo-question";
const keyFor = (input: PhotoQuestionRecognitionInput) => `${kind}:${input.sourceId}:v${input.sourceVersion}`;
const conflict = (message: string) => Object.assign(new Error(message), { code: "CONFLICT" });

async function assertSource(tx: Sql | TransactionSql, scope: Scope, input: PhotoQuestionRecognitionInput) {
  const [workspace] = await tx`SELECT id,privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
  const [source] = workspace ? await tx`SELECT id FROM opening_sources s WHERE s.id=${input.sourceId} AND s.workspace_id=${scope.workspaceId}
    AND s.version=${input.sourceVersion} AND s.upload_state='uploaded' AND s.mime IN ('image/jpeg','image/png','image/webp')
    AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id) FOR SHARE` : [];
  if (!source) throw conflict("题图不可用、版本已更新或已排除，请核对原图；仍可手动填写题干。");
  return Number(workspace!.privacy_epoch);
}

/** All reads, admission, pre-send checks and publication recheck live source facts. */
export function createOpeningPhotoRecognitionRepository(sql: Sql) {
  return {
    async read(scope: Scope, raw: PhotoQuestionRecognitionInput): Promise<PhotoQuestionRecognitionResponse> {
      const input = photoQuestionRecognitionInputSchema.parse(raw);
      return sql.begin(async tx => {
        const epoch = await assertSource(tx, scope, input);
        const [row] = await tx`SELECT id,state,result,privacy_epoch FROM opening_jobs WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND key=${keyFor(input)} AND kind=${kind}`;
        if (!row) return { ...input, jobId: null, status: "idle", proposal: null };
        if (Number(row.privacy_epoch) !== epoch) throw conflict("资料隐私设置已改变，旧识别结果不再读取。请核对原图并手动填写题干。");
        const proposal = row.state === "succeeded" ? photoQuestionRecognitionProposalSchema.parse(row.result) : null;
        const status = row.state === "succeeded" ? "ready" : row.state === "outcome_unknown" ? "unknown" : String(row.state);
        return { ...input, jobId: String(row.id), status: status as PhotoQuestionRecognitionResponse["status"], proposal };
      });
    },
    async begin(scope: Scope, raw: PhotoQuestionRecognitionInput) {
      const input = photoQuestionRecognitionInputSchema.parse(raw);
      await sql.begin(async tx => {
        const epoch = await assertSource(tx, scope, input);
        const [created] = await tx`INSERT INTO opening_jobs(workspace_id,owner_user_id,key,kind,payload,privacy_epoch)
          VALUES(${scope.workspaceId},${scope.ownerUserId},${keyFor(input)},${kind},${tx.json(input)},${epoch})
          ON CONFLICT(workspace_id,key) DO NOTHING RETURNING id`;
        if (created) await tx`INSERT INTO opening_outbox(workspace_id,job_id,topic,payload)
          VALUES(${scope.workspaceId},${created.id},'opening.job.enqueue',${tx.json({ kind, jobId: created.id })})`;
      });
      return this.read(scope, input);
    },
    async assertCurrent(scope: OpeningJobScope, raw: PhotoQuestionRecognitionInput) {
      const input = photoQuestionRecognitionInputSchema.parse(raw);
      await sql.begin(async tx => { await lockOpeningJobExecution(tx, scope); await assertSource(tx, scope, input); });
    },
    async complete(scope: OpeningJobScope, raw: PhotoQuestionRecognitionInput, rawProposal: PhotoQuestionRecognitionProposal) {
      const input = photoQuestionRecognitionInputSchema.parse(raw), proposal = photoQuestionRecognitionProposalSchema.parse(rawProposal);
      if (!scope.jobExecution) throw conflict("识别任务缺少执行凭据。");
      await sql.begin(async tx => {
        await lockOpeningJobExecution(tx, scope);
        await assertSource(tx, scope, input);
        const rows = await tx`UPDATE opening_jobs SET state='succeeded',result=${tx.json(proposal)},updated_at=now()
          WHERE id=${scope.jobExecution!.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          AND kind=${kind} AND key=${keyFor(input)} AND state='running' AND claim_token=${scope.jobExecution!.token} RETURNING id`;
        if (!rows.length) throw conflict("识别任务已结束，未发布迟到结果。");
      });
    },
  };
}
