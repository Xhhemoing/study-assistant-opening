import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import { assistantProposalCreateSchema, assistantProposalDecisionSchema, assistantProposalRecordSchema, localReplanMetadataSchema, plannedBlockSchema,
  type AssistantProposalCreate, type AssistantProposalDecision, type AssistantProposalRecord, type PendingAssistantProposalsQuery, type Scope } from "@aistudy/contracts";
import { lockWorkspaceLearningHistory, learningError } from "./opening-learning-facts";
import { readOpeningLearnerState } from "./opening-learner-state-read";
import { contextSourceRefsIncluded, parseContextSourceRefs, turnContextSourceRefs } from "./opening-context-provenance";
import { resolveWorkspaceTimeZone } from "@aistudy/domain";
import { dailyDraftAdvisoryLockKeys } from "./opening-plans";
import { proposeOpeningLocalPlan } from "./opening-local-replan";
import { applyAssistantProposal, proposalTransactionClient } from "./opening-assistant-proposal-effects";
import { countPendingAssistantProposals, listPendingAssistantProposals } from "./opening-assistant-proposal-pending";

const map = (row: Record<string, unknown>): AssistantProposalRecord => {
  const intent = assistantProposalCreateSchema.parse(row.intent);
  return assistantProposalRecordSchema.parse({ id: row.id, sourceTurnId: row.source_turn_id, tool: intent.tool, version: Number(row.version), status: row.status,
    createdAt: new Date(row.created_at as Date).toISOString(), basisVersion: row.basis_version, result: row.result ?? null, prepared: row.prepared ?? null });
};
async function lockProposalScope(tx: TransactionSql, scope: Scope, tool: AssistantProposalCreate["tool"]) {
  // Same order as the native plan accept path: day advisory, history, workspace.
  if (tool.name === "propose_plan_change") {
    const [a, b] = dailyDraftAdvisoryLockKeys(scope.workspaceId, tool.arguments.date);
    await tx`SELECT pg_advisory_xact_lock(${a},${b})`;
  }
  await lockWorkspaceLearningHistory(tx, scope);
  const [owner] = await tx`SELECT w.privacy_epoch,p.updated_at FROM workspaces w LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
    WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId} FOR UPDATE OF w`;
  if (!owner) throw learningError("NOT_FOUND", "workspace not found");
  return owner;
}
async function proposalBasis(tx: TransactionSql, scope: Scope, owner: Record<string, unknown>) {
  const state = await readOpeningLearnerState(tx, scope);
  return `${state.stateVersion}:privacy:${owner.privacy_epoch}:prefs:${owner.updated_at ? new Date(owner.updated_at as Date).toISOString() : "none"}`;
}
async function admitSourceTurn(tx: TransactionSql, scope: Scope, id: string) {
  const [turn] = await tx`SELECT t.id,${turnContextSourceRefs(tx, "t")} AS refs FROM opening_turns t
    JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
    WHERE t.id=${id} AND t.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId} AND t.role='user' AND t.status='complete'`;
  if (!turn) throw learningError("NOT_FOUND", "proposal requires a complete owned user turn");
  const refs = parseContextSourceRefs(turn.refs);
  if (!refs || refs.length > 64) throw learningError("CONFLICT", "proposal source provenance unavailable");
  const [admission] = await tx`SELECT ${contextSourceRefsIncluded(tx, scope.workspaceId, tx`${tx.json(refs)}::jsonb`)} AS included`;
  if (!admission?.included) throw learningError("CONFLICT", "proposal sources changed or unavailable");
  return refs;
}
/** Proposal tools only create drafts. Explicit acceptance owns every actual mutation. */
export function createOpeningAssistantProposalsRepository(sql: Sql, options: { enqueueTeachingCompile?: boolean; now?: () => Date } = {}) {
  return {
    listPending: (scope: Scope, query: PendingAssistantProposalsQuery = {}) => listPendingAssistantProposals(sql, scope, query, map),
    countPending: (scope: Scope) => countPendingAssistantProposals(sql, scope),
    async propose(scope: Scope, raw: AssistantProposalCreate, runtime?: { jobLease?: { jobId: string; claimToken: string }; expectedPrivacyEpoch?: number }): Promise<AssistantProposalRecord> {
      const intent = assistantProposalCreateSchema.parse(raw);
      return sql.begin(async tx => {
        const owner = await lockProposalScope(tx, scope, intent.tool);
        if (runtime?.expectedPrivacyEpoch !== undefined && Number(owner.privacy_epoch) !== runtime.expectedPrivacyEpoch) throw learningError("CONFLICT", "proposal privacy changed");
        if (runtime?.jobLease) {
          const [lease] = await tx`SELECT id FROM opening_tutor_jobs WHERE id=${runtime.jobLease.jobId} AND workspace_id=${scope.workspaceId}
            AND user_turn_id=${intent.sourceTurnId} AND status='running' AND claim_token=${runtime.jobLease.claimToken} FOR UPDATE`;
          if (!lease) throw learningError("CONFLICT", "proposal job lease is no longer current");
        }
        const [replay] = await tx`SELECT * FROM opening_assistant_proposals WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND client_key=${intent.clientKey}`;
        if (replay) {
          if (!isDeepStrictEqual(replay.intent, intent)) throw learningError("CONFLICT", "proposal key reused for another intent");
          await admitSourceTurn(tx, scope, intent.sourceTurnId);
          return map(replay);
        }
        const refs = await admitSourceTurn(tx, scope, intent.sourceTurnId);
        const basisVersion = await proposalBasis(tx, scope, owner);
        let prepared: AssistantProposalRecord["prepared"] = null;
        if (intent.tool.name === "propose_plan_change") {
          const planned = await proposeOpeningLocalPlan(proposalTransactionClient(tx), scope, { ...intent.tool.arguments, clientKey: `proposal-plan:${intent.clientKey}` }, { now: options.now?.() });
          if (planned.kind !== "draft") throw learningError("CONFLICT", "current plan needs no change");
          const [storedDraft] = await tx`SELECT input_snapshot FROM opening_plan_drafts WHERE id=${planned.draft.id}
            AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
          const snapshot = localReplanMetadataSchema.parse(storedDraft?.input_snapshot?.localReplan);
          const proposedBlocks = plannedBlockSchema.array().max(200).parse(planned.draft.blocks);
          const ids = [...new Set([...snapshot.baselineBlocks.map(block => block.taskId), ...proposedBlocks.map(block => block.taskId), ...planned.draft.unscheduledTaskIds])];
          const titles = ids.length ? await tx`SELECT id,title FROM opening_tasks WHERE workspace_id=${scope.workspaceId}
            AND owner_user_id=${scope.ownerUserId} AND id=ANY(${ids}::uuid[])` : [];
          const [preference] = await tx`SELECT planning_settings FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
          prepared = { draftId: planned.draft.id, expectedBaseVersion: planned.draft.baseVersion, expectedDraftVersion: planned.draft.version,
            preview: { timeZone: resolveWorkspaceTimeZone(preference?.planning_settings?.timeZone), previousBlocks: snapshot.baselineBlocks,
              proposedBlocks, tasks: titles.map(task => ({ id: String(task.id), title: String(task.title).slice(0, 240) })), unscheduledTaskIds: planned.draft.unscheduledTaskIds } };
        }
        const [row] = await tx`INSERT INTO opening_assistant_proposals(id,workspace_id,owner_user_id,source_turn_id,client_key,intent,prepared,context_source_refs,basis_version,privacy_epoch)
          VALUES(${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${intent.sourceTurnId},${intent.clientKey},${tx.json(intent)},${prepared ? tx.json(prepared) : null},${tx.json(refs)},${basisVersion},${Number(owner.privacy_epoch)}) RETURNING *`;
        return map(row!);
      }) as Promise<AssistantProposalRecord>;
    },
    async findByClientKey(scope: Scope, clientKey: string): Promise<AssistantProposalRecord | null> {
      const [row] = await sql`SELECT p.* FROM opening_assistant_proposals p JOIN workspaces w ON w.id=p.workspace_id AND w.owner_user_id=p.owner_user_id
        WHERE p.workspace_id=${scope.workspaceId} AND p.owner_user_id=${scope.ownerUserId} AND p.client_key=${clientKey} AND p.privacy_epoch=w.privacy_epoch
          AND ${contextSourceRefsIncluded(sql, scope.workspaceId, sql`p.context_source_refs`)}`;
      return row ? map(row) : null;
    },
    async list(scope: Scope): Promise<AssistantProposalRecord[]> {
      const rows = await sql`SELECT p.* FROM opening_assistant_proposals p JOIN workspaces w ON w.id=p.workspace_id AND w.owner_user_id=p.owner_user_id
        WHERE p.workspace_id=${scope.workspaceId} AND p.owner_user_id=${scope.ownerUserId} AND p.privacy_epoch=w.privacy_epoch
          AND ${contextSourceRefsIncluded(sql, scope.workspaceId, sql`p.context_source_refs`)} ORDER BY p.created_at DESC,p.id LIMIT 40`;
      return rows.map(map);
    },
    async decide(scope: Scope, id: string, raw: AssistantProposalDecision): Promise<AssistantProposalRecord> {
      const input = assistantProposalDecisionSchema.parse(raw);
      return sql.begin(async tx => {
        const [preview] = await tx`SELECT * FROM opening_assistant_proposals WHERE id=${id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        if (!preview) throw learningError("NOT_FOUND", "proposal not found");
        const intent = assistantProposalCreateSchema.parse(preview.intent);
        const owner = await lockProposalScope(tx, scope, intent.tool);
        const [row] = await tx`SELECT * FROM opening_assistant_proposals WHERE id=${id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!row) throw learningError("NOT_FOUND", "proposal not found");
        if (row.status !== "draft") {
          if (row.decision_client_key !== input.clientKey || row.decision_action !== input.action || Number(row.version) !== input.expectedVersion + 1) throw learningError("CONFLICT", "proposal already decided");
          if (Number(row.privacy_epoch) !== Number(owner.privacy_epoch)) throw learningError("CONFLICT", "privacy changed");
          await admitSourceTurn(tx, scope, intent.sourceTurnId);
          return map(row);
        }
        if (Number(row.version) !== input.expectedVersion) throw learningError("CONFLICT", "proposal version changed");
        let result: AssistantProposalRecord["result"] = null;
        if (input.action === "accept") {
          if (Number(row.privacy_epoch) !== Number(owner.privacy_epoch) || row.basis_version !== await proposalBasis(tx, scope, owner)) throw learningError("CONFLICT", "proposal basis changed; regenerate draft");
          const refs = await admitSourceTurn(tx, scope, intent.sourceTurnId);
          if (!isDeepStrictEqual(refs, parseContextSourceRefs(row.context_source_refs))) throw learningError("CONFLICT", "proposal provenance changed");
          result = await applyAssistantProposal(tx, scope, intent, map(row).prepared, refs, id, options);
        }
        const [updated] = await tx`UPDATE opening_assistant_proposals SET status=${input.action === "accept" ? "accepted" : "rejected"},version=version+1,
          decision_client_key=${input.clientKey},decision_action=${input.action},result=${result ? tx.json(result) : null},updated_at=now()
          WHERE id=${id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status='draft' AND version=${input.expectedVersion} RETURNING *`;
        if (!updated) throw learningError("CONFLICT", "proposal changed during acceptance");
        return map(updated);
      }) as Promise<AssistantProposalRecord>;
    },
  };
}
