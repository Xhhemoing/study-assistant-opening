import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { AssistantProposalCreate, AssistantProposalRecord, Scope } from "@aistudy/contracts";
import { createOpeningTeachingActivitiesRepository } from "./opening-teaching-activities";
import { acceptOpeningPlan } from "./opening-plan-accept";
import { createCardRepository } from "./cards";
import { readOpeningObservationCardDraft } from "./opening-card-drafts";
import { createLibraryRepository } from "./library";
import { createOpeningMemoryRepository } from "./opening-memory";
import { reviseOpeningLearningObservation } from "./opening-observation-revisions";
import { admitLearningSources, learningError } from "./opening-learning-facts";
import type { ContextSourceRef } from "./opening-context-provenance";

/** Existing repositories keep their mutation invariants, inside this acceptance transaction. */
export function proposalTransactionClient(tx: TransactionSql): Sql {
  return new Proxy(tx, { get(target, key, receiver) {
    if (key === "begin") return (...args: unknown[]) => {
      const execute = args.at(-1) as (nested: TransactionSql) => Promise<unknown>;
      return target.savepoint(nested => execute(nested));
    };
    return Reflect.get(target, key, receiver);
  } }) as unknown as Sql;
}
export async function applyAssistantProposal(tx: TransactionSql, scope: Scope, intent: AssistantProposalCreate,
  prepared: AssistantProposalRecord["prepared"], refs: ContextSourceRef[], proposalId: string, options: { enqueueTeachingCompile?: boolean; now?: () => Date } = {}): Promise<NonNullable<AssistantProposalRecord["result"]>> {
  const db = proposalTransactionClient(tx), tool = intent.tool;
  const key = `assistant-proposal:${proposalId}`;
  if (tool.name === "propose_teaching_move") {
    const activity = await createOpeningTeachingActivitiesRepository(db).create(scope, { clientKey: key, sourceTurnId: intent.sourceTurnId,
      intentKind: "topic", intentSummary: tool.arguments.topic, courseId: tool.arguments.courseId,
      sourceIds: [...new Set(refs.map(ref => ref.sourceId))], createIntent: { source: "assistant_proposal", proposalId } }, { enqueueCompile: options.enqueueTeachingCompile ?? false });
    return { kind: "teaching_activity", id: activity.id, href: `/opening/courses/${tool.arguments.courseId}/study?activity=${activity.id}` };
  }
  if (tool.name === "propose_plan_change") {
    if (!prepared) throw learningError("CONFLICT", "plan draft unavailable");
    const [current] = await tx`SELECT version,blocks,unscheduled_task_ids,input_snapshot FROM opening_plan_drafts WHERE id=${prepared.draftId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
    if (!current || Number(current.version) !== prepared.expectedDraftVersion) throw learningError("CONFLICT", "plan draft version changed");
    if (!prepared.preview || !isDeepStrictEqual(current.blocks, prepared.preview.proposedBlocks)
      || !isDeepStrictEqual(current.unscheduled_task_ids, prepared.preview.unscheduledTaskIds)
      || !isDeepStrictEqual(current.input_snapshot?.localReplan?.baselineBlocks, prepared.preview.previousBlocks)) {
      throw learningError("CONFLICT", "plan preview differs from draft; regenerate before accepting");
    }
    const draft = await acceptOpeningPlan(db, scope, { draftId: prepared.draftId, expectedBaseVersion: prepared.expectedBaseVersion, clientKey: key }, options.now?.() ?? new Date(), { expectedDraftVersion: prepared.expectedDraftVersion });
    return { kind: "plan", id: String(draft.id), href: "/opening/today" };
  }
  if (tool.name === "propose_card") {
    const origin = await readOpeningObservationCardDraft(db, scope, tool.arguments.observationId);
    const card = await createCardRepository(db).createCard({ ...scope, front: tool.arguments.front, back: tool.arguments.back,
      observationId: tool.arguments.observationId, courseId: origin.courseId, skillLabel: origin.skillLabel });
    const [stored] = await tx`SELECT source_ids FROM cards WHERE id=${card.id} AND workspace_id=${scope.workspaceId}`;
    const sourceIds = [...new Set([...(stored?.source_ids as string[] ?? []), ...refs.map(ref => ref.sourceId)])].sort();
    if (sourceIds.length > 32) throw learningError("VALIDATION", "card source lineage exceeds 32 materials");
    await admitLearningSources(tx, scope, sourceIds);
    await tx`UPDATE cards SET source_ids=${sourceIds}::uuid[] WHERE id=${card.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    return { kind: "card", id: card.id, href: "/opening/cards" };
  }
  if (tool.name === "propose_note") {
    const note = await createLibraryRepository(db).createDocument({ workspaceId: scope.workspaceId, title: tool.arguments.title,
      lifecycle: "scratch", blocks: [{ id: randomUUID(), type: "paragraph", content: { blockNoteContent: [{ type: "text", text: tool.arguments.text, styles: {} }], props: {}, children: [] } }] });
    await tx`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
      VALUES(${note.id},${scope.workspaceId},${tx.json(refs)})`;
    return { kind: "note", id: note.id, href: `/opening/library/${note.id}` };
  }
  if (tool.name === "propose_memory") {
    const memory = createOpeningMemoryRepository(db);
    const candidate = await memory.proposeMemory(scope, { text: tool.arguments.text, sourceTurnIds: [intent.sourceTurnId],
      courseId: tool.arguments.courseId ?? null, expiresAt: null });
    const confirmed = await memory.confirm(scope, candidate.id, candidate.version, key);
    return { kind: "memory", id: confirmed.id, href: "/opening/library?tab=review" };
  }
  const [head] = await tx`SELECT * FROM opening_learning_observations WHERE id=${tool.arguments.expectedHead}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    AND COALESCE(root_observation_id,id)=${tool.arguments.rootObservationId}`;
  if (!head) throw learningError("NOT_FOUND", "disputed observation unavailable");
  const revised = await reviseOpeningLearningObservation(db, scope, { rootObservationId: tool.arguments.rootObservationId,
    revisesObservationId: tool.arguments.expectedHead, expectedHead: tool.arguments.expectedHead, reason: tool.arguments.reason,
    revisionKind: "replace", clientKey: key, replacement: { answer: String(head.answer), outcome: "unverified", assistance: head.assistance as "independent" | "hinted" | "revealed" | "unknown", verdictSource: "self_report" } });
  return { kind: "dispute", id: revised.headObservationId, href: `/opening/courses/${head.course_id}?tab=records` };
}
