import type { LearningObservation, Scope, StudyContextAnchor, StudyExposureReceipt } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { isDeepStrictEqual } from "node:util";
import { parseContextSourceRefs } from "./opening-context-provenance";
import { learningError, lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { createOpeningStudyExposureRepository, generateOpeningStudyExposure, mapOpeningStudyExposure, releaseOpeningStudyExposure, type OpeningStudyExposureInput } from "./opening-study-exposure";

type OriginReference = NonNullable<OpeningStudyExposureInput["originReference"]>;
type Delivery = { anchor: StudyContextAnchor; reference: OriginReference };
/** Delivery policy lives here; neither content readers nor client supplied help labels write facts. */
export function createOpeningContentDeliveryRepository(sql: Sql) {
  const exposures = createOpeningStudyExposureRepository(sql);
  async function deliver(scope: Scope, releaseKey: string, origin: OpeningStudyExposureInput["origin"], deliveries: Delivery[]): Promise<StudyExposureReceipt[]> {
    const receipts: StudyExposureReceipt[] = [];
    for (const [index, delivery] of deliveries.entries()) {
      receipts.push(await exposures.deliver(scope, { releaseKey: `${releaseKey}:${origin}:${index}`, contextAnchor: delivery.anchor,
        // These full bodies can contain worked steps or answers. They are not
        // certified concept-only instruction: exact-item/source matches must at
        // least narrow independence to unknown, without affecting unrelated items.
        origin, originReference: delivery.reference, kind: origin === "card_answer" ? "solution" : "hint",
        level: origin === "card_answer" ? "revealed" : "hinted", supportDomain: "unknown" }));
    }
    return receipts;
  }
  /** Unknown note provenance can only narrow attempts already open at release.
   * The shared history lock makes selection/release atomic with create/submit.
   * Replays return the original target set instead of contaminating newer attempts.
   */
  async function deliverUnassociatedNote(scope: Scope, releaseKey: string, reference: OriginReference): Promise<StudyExposureReceipt[]> {
    return sql.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, scope);
      const batchKey = `${releaseKey}:note:generic`;
      const existing = await tx`SELECT * FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId}
        AND owner_user_id=${scope.ownerUserId} AND (release_key=${batchKey} OR release_key LIKE ${`${batchKey}:target:%`}) ORDER BY release_key`;
      if (existing.length) {
        for (const row of existing) {
          const saved = (row.release_intent as OpeningStudyExposureInput).originReference;
          const savedReference = { ...saved };
          delete savedReference.possibleOpenAttemptOnly;
          if (!isDeepStrictEqual(savedReference, reference)) throw learningError("CONFLICT", "note delivery identity changed on replay");
        }
        return existing.map(mapOpeningStudyExposure);
      }
      const open = await tx`SELECT a.id FROM opening_learning_attempts a
        JOIN opening_learning_sessions s ON s.id=a.session_id AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id
        JOIN opening_teaching_activities activity ON activity.id=a.activity_id AND activity.workspace_id=a.workspace_id AND activity.owner_user_id=a.owner_user_id
        JOIN courses c ON c.id=a.course_id AND c.workspace_id=a.workspace_id AND c.archived_at IS NULL
        WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
          AND a.submitted_at IS NULL AND a.observation_id IS NULL AND activity.status='active' ORDER BY a.id FOR SHARE OF a,s,activity,c`;
      const inputs: OpeningStudyExposureInput[] = [{ releaseKey: batchKey, contextAnchor: { purpose: "note_read" }, origin: "note", originReference: reference, kind: "hint", level: "hinted", supportDomain: "unknown" },
        ...open.map(attempt => ({ releaseKey: `${batchKey}:target:${String(attempt.id)}`, contextAnchor: { purpose: "note_read" as const, attemptId: String(attempt.id) }, origin: "note" as const,
          originReference: { ...reference, possibleOpenAttemptOnly: true }, kind: "hint" as const, level: "hinted" as const, supportDomain: "unknown" as const }))];
      const receipts: StudyExposureReceipt[] = [];
      for (const input of inputs) {
        const generated = await generateOpeningStudyExposure(tx, scope, input);
        receipts.push(await releaseOpeningStudyExposure(tx, scope, generated.id));
      }
      return receipts;
    }) as Promise<StudyExposureReceipt[]>;
  }
  return {
    /** Invoke only after the version-pinned owner-only source reader succeeds. */
    source(scope: Scope, key: string, content: { sourceId: string; version: number; page: number | null }) {
      return deliver(scope, key, "material_excerpt", [{ anchor: { purpose: "material_read", sourceId: content.sourceId, sourceVersion: content.version, page: content.page },
        reference: { type: "source", id: content.sourceId, version: String(content.version) } }]);
    },
    /** The editor has already authorized and loaded this exact document revision. */
    async note(scope: Scope, key: string, document: { id: string; currentRevisionNumber: number }): Promise<StudyExposureReceipt[]> {
      const [row] = await sql`SELECT d.id,np.document_id AS provenance_id,np.context_source_refs FROM library_documents d
        JOIN workspaces w ON w.id=d.workspace_id AND w.owner_user_id=${scope.ownerUserId}
        LEFT JOIN opening_note_provenance np ON np.document_id=d.id AND np.workspace_id=d.workspace_id
        WHERE d.id=${document.id} AND d.workspace_id=${scope.workspaceId} AND d.deleted_at IS NULL
          AND EXISTS(SELECT 1 FROM library_revisions r WHERE r.document_id=d.id AND r.workspace_id=d.workspace_id AND r.revision_number=${document.currentRevisionNumber})`;
      if (!row) throw learningError("NOT_FOUND", "note revision unavailable for delivery");
      const refs = row.provenance_id ? parseContextSourceRefs(row.context_source_refs) : [];
      const reference: OriginReference = { type: "note", id: document.id, version: String(document.currentRevisionNumber) };
      if (!refs?.length) return deliverUnassociatedNote(scope, key, reference);
      const deliveries = refs?.length ? refs.map(ref => ({ anchor: { purpose: "note_read" as const, sourceId: ref.sourceId, sourceVersion: ref.sourceVersion }, reference })) : [{ anchor: { purpose: "note_read" as const }, reference }];
      return deliver(scope, key, "note", deliveries);
    },
    /** Queue payloads already include the back, so release happens before the GET response. */
    async cards(scope: Scope, key: string, cards: readonly { id: string; contentVersion: number }[]): Promise<StudyExposureReceipt[]> {
      if (!cards.length) return [];
      const ids = cards.map(card => card.id);
      const rows = await sql`SELECT c.id,c.content_version,c.source_ids,c.course_id,c.skill_label,np.context_source_refs
        FROM cards c JOIN workspaces w ON w.id=c.workspace_id AND w.owner_user_id=${scope.ownerUserId}
        LEFT JOIN opening_note_provenance np ON np.document_id=c.source_document_id AND np.workspace_id=c.workspace_id
        WHERE c.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId} AND c.id=ANY(${ids}::uuid[]) ORDER BY c.id`;
      const byId = new Map(rows.map(row => [String(row.id), row]));
      const deliveries: Delivery[] = [];
      for (const card of cards) {
        const row = byId.get(card.id);
        if (!row || Number(row.content_version) !== card.contentVersion) throw learningError("CONFLICT", "card version changed before delivery");
        const refs = parseContextSourceRefs(row.context_source_refs);
        const sourceIds = row.source_ids as string[];
        const sourceRefs = [...(refs ?? []), ...sourceIds.filter(sourceId => !refs?.some(ref => ref.sourceId === sourceId)).map(sourceId => ({ sourceId, sourceVersion: null }))];
        const reference: OriginReference = { type: "card", id: card.id, version: String(card.contentVersion), sourceRefs, skillLabel: row.skill_label as string | null };
        // Legacy cards have source IDs but no frozen versions. Never substitute the
        // current material version for the origin of their previously written answer.
        if (refs?.length) for (const ref of refs) deliveries.push({ anchor: { purpose: "card_answer", sourceId: ref.sourceId, sourceVersion: ref.sourceVersion }, reference });
        else deliveries.push({ anchor: { purpose: "card_answer" }, reference });
      }
      return deliver(scope, key, "card_answer", deliveries);
    },
    /** Historical student answers are instruction exposure, not an invented reference solution. */
    async history(scope: Scope, key: string, observations: readonly LearningObservation[]): Promise<StudyExposureReceipt[]> {
      const deliveries: Delivery[] = [];
      const seen = new Set<string>();
      for (const observation of observations) {
        // Different revisions may contain different answers. Preserve their
        // individual origin identities even when they share an item version.
        const identity = observation.id;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const reference: OriginReference = { type: "observation", id: observation.id, version: String(observation.historyRevision ?? 0),
          sourceRefs: observation.sourceIds.map(sourceId => ({ sourceId, sourceVersion: observation.sourceVersions?.[sourceId] ?? null })),
          skillLabel: observation.skillLabel, requirementKey: observation.requirementKey };
        const [course] = await sql`SELECT id FROM courses WHERE id=${observation.courseId} AND workspace_id=${scope.workspaceId} AND archived_at IS NULL`;
        const anchor: StudyContextAnchor = course ? { purpose: "history_solution", ...(observation.itemVersionId ? { itemVersionId: observation.itemVersionId } : observation.attemptId ? { attemptId: observation.attemptId } : {}) } : { purpose: "history_solution" };
        deliveries.push({ anchor, reference });
      }
      return deliver(scope, key, "history_solution", deliveries);
    },
  };
}
