import { aiGradingWorkSourceSchema, answerInterpretationMetadataSchema } from "@aistudy/contracts";
import { isDeepStrictEqual } from "node:util";

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const identity = (value: unknown): string => typeof value === "string" ? value.toLowerCase() : "";

/** Restore identity/provenance, never model verdicts, reservations or paid jobs.
 * Older archives follow 0093's predecessor-based ordinals and legacy paid keys;
 * current manual judgements/retractions can share the previous answer identity. */
export function restoreOpeningGradingMetadata(rows: Row[], workspaceId: string, ownerUserId?: string): Row[] {
  const byId = new Map<string, Row>();
  for (const row of rows) {
    const id = identity(row.id);
    if (!id || byId.has(id)) throw new Error("invalid or duplicate restored observation identity");
    if (identity(row.workspace_id) !== identity(workspaceId) || !identity(row.owner_user_id)
      || ownerUserId !== undefined && identity(row.owner_user_id) !== identity(ownerUserId)) {
      throw new Error("restored observation workspace or owner mismatch");
    }
    byId.set(id, row);
  }
  const completed = new Map<string, Row>();
  const visiting = new Set<string>();
  function visit(row: Row): Row {
    const id = identity(row.id);
    const saved = completed.get(id);
    if (saved) return saved;
    if (visiting.has(id)) throw new Error("invalid restored observation revision cycle");
    visiting.add(id);
    const predecessor = row.revises_observation_id == null ? null : byId.get(identity(row.revises_observation_id));
    if (row.revises_observation_id != null && !predecessor) throw new Error("restored observation predecessor is missing");
    const previous = predecessor ? visit(predecessor) : null;
    const root = identity(row.root_observation_id ?? row.id);
    if (previous ? root !== identity(previous.root_observation_id ?? previous.id) : root !== id) {
      throw new Error("restored observation predecessor belongs to another root");
    }
    if (previous && identity(row.owner_user_id) !== identity(previous.owner_user_id)) {
      throw new Error("restored observation predecessor belongs to another owner");
    }
    const ai = record(row.ai_evaluation);
    const gradingInput = record(record(record(row.submitted_intent)?.aiGrading)?.input);
    if (gradingInput && (!previous || identity(gradingInput.observationId) !== identity(previous.id))) {
      throw new Error("invalid restored grading input identity");
    }
    const ordinal = row.answer_revision ?? (previous ? Number(previous.answer_revision) + (ai || gradingInput ? 0 : 1) : 1);
    if (!Number.isSafeInteger(ordinal) || Number(ordinal) < 1
      || (previous ? Number(ordinal) < Number(previous.answer_revision) || Number(ordinal) > Number(previous.answer_revision) + 1 : ordinal !== 1)) {
      throw new Error("invalid restored answer revision");
    }
    const sameRevision = previous !== null && ordinal === previous.answer_revision;
    if (sameRevision && row.answer !== previous.answer) throw new Error("restored answer changed without a new answer revision");
    const legacyKey = `ai-grade:${identity(workspaceId)}:${id}`;
    const revisionKey = `ai-grade:${identity(workspaceId)}:${root}:${ordinal}`;
    // An AI result (or unchanged manual head) must not acquire a fresh key on
    // restore. In particular the legacy AI result spent on its predecessor ID.
    const operation = row.grading_operation_id ?? (sameRevision ? previous.grading_operation_id : legacyKey);
    if (sameRevision ? operation !== previous.grading_operation_id : operation !== legacyKey && operation !== revisionKey) {
      throw new Error("invalid restored grading operation identity");
    }
    // 0093 assigned each legacy non-AI revision its own row-based key, even for
    // unchanged text. Keep those facts, but do not manufacture a modern paid key.
    const interpretationRaw = record(row.submitted_intent)?.answerInterpretation;
    if (previous && !sameRevision && row.answer === previous.answer && operation !== legacyKey && interpretationRaw === undefined) {
      throw new Error("restored unchanged answer cannot acquire a new grading operation identity");
    }
    const rawPhoto = row.grading_work_source ?? ai?.workSource ?? previous?.grading_work_source ?? null;
    const photo = rawPhoto == null ? null : aiGradingWorkSourceSchema.parse(rawPhoto);
    if (photo) {
      const versions = record(row.source_versions);
      if (!Array.isArray(row.source_ids) || !row.source_ids.includes(photo.id) || versions?.[photo.id] !== photo.version) {
        throw new Error("restored answer photo is outside captured source provenance");
      }
    }
    // Legacy AI grading could attach a first photo; an already sealed photo
    // cannot be swapped for another version/page under the same answer identity.
    if (sameRevision && !isDeepStrictEqual(photo, previous.grading_work_source)
      && (previous.grading_work_source != null || !ai && !gradingInput)) {
      throw new Error("restored answer photo changed without a new answer revision");
    }
    if (interpretationRaw !== undefined) {
      const interpretation = answerInterpretationMetadataSchema.parse(interpretationRaw);
      const original = byId.get(identity(interpretation.originalTranscriptionObservationId));
      const originalAi = record(original?.ai_evaluation) ?? record(record(record(original?.submitted_intent)?.aiGrading)?.proposal);
      const prior = interpretation.previousInterpretationObservationId == null ? null : byId.get(identity(interpretation.previousInterpretationObservationId));
      const priorMetadata = prior ? answerInterpretationMetadataSchema.safeParse(record(prior.submitted_intent)?.answerInterpretation) : null;
      const sameRoot = (other: Row | undefined | null) => other && identity(other.root_observation_id ?? other.id) === root && identity(other.owner_user_id) === identity(row.owner_user_id);
      const ancestors = new Set<string>();
      for (let ancestor: Row | null | undefined = predecessor; ancestor; ancestor = ancestor.revises_observation_id == null ? undefined : byId.get(identity(ancestor.revises_observation_id))) ancestors.add(identity(ancestor.id));
      if (!previous || !sameRoot(original) || !ancestors.has(identity(original?.id)) || !isDeepStrictEqual(interpretation.workSource, photo) || row.answer !== interpretation.correctedTranscription
        || originalAi?.transcription !== undefined && originalAi.transcription !== interpretation.originalTranscription
        || (prior ? !sameRoot(prior) || !ancestors.has(identity(prior.id)) || !priorMetadata?.success || priorMetadata.data.version + 1 !== interpretation.version
          || priorMetadata.data.originalTranscriptionObservationId !== interpretation.originalTranscriptionObservationId
          || priorMetadata.data.originalTranscription !== interpretation.originalTranscription
          : interpretation.previousInterpretationObservationId !== null || interpretation.version !== 1)) {
        throw new Error("restored photo interpretation identity or revision is invalid");
      }
    }
    const result = { ...row, answer_revision: Number(ordinal), grading_work_source: photo, grading_operation_id: operation };
    completed.set(id, result);
    visiting.delete(id);
    return result;
  }
  const restored = rows.map(visit);
  const successors = new Set<string>();
  for (const row of restored) {
    if (row.revises_observation_id == null) continue;
    const predecessorId = identity(row.revises_observation_id);
    if (successors.has(predecessorId)) throw new Error("invalid restored observation revision fork");
    successors.add(predecessorId);
  }
  for (const row of restored) {
    if (row.effective_head_id == null) continue;
    const head = completed.get(identity(row.effective_head_id));
    if (!head || successors.has(identity(head.id))
      || identity(head.root_observation_id ?? head.id) !== identity(row.root_observation_id ?? row.id)
      || identity(head.owner_user_id) !== identity(row.owner_user_id)) throw new Error("invalid restored observation head identity");
  }
  return restored;
}
