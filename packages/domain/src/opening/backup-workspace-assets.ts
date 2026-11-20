import { courseExamSnapshotSchema, knowledgeSnapshotSchema } from "@aistudy/contracts";
import { COURSE_BACKUP_TABLES, LIBRARY_BACKUP_TABLES } from "../../../contracts/src/opening/backup-inventory";
import { isRecord, isUuid, sourceReferences } from "./backup-validation";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type AssetTable = (typeof COURSE_BACKUP_TABLES)[number] | (typeof LIBRARY_BACKUP_TABLES)[number];

// Database identities are scoped by the already validated workspace.
const primaryKeys: Record<AssetTable, readonly string[]> = {
  library_documents: ["id"], library_blocks: ["id"], library_relations: ["id"], library_revisions: ["id"],
  library_properties: ["id"], opening_note_provenance: ["document_id"], opening_course_knowledge: ["course_id"],
  opening_knowledge_confirmations: ["id"], opening_exam_sprints: ["id"], opening_exam_papers: ["id"],
  opening_exam_bindings: ["sprint_id"], opening_exam_attempt_links: ["id"], opening_exam_reviews: ["id"],
  opening_exam_source_mappings: ["sprint_id", "source_item_id"],
  opening_exam_source_observations: ["sprint_id", "source_record_id"], opening_exam_help_receipts: ["id"],
};

/** Source IDs inside exam JSON also occur under workSourceId and packSourceId.
 * Legacy sourceRecords.sourceId is a catalog item key, not an Opening source UUID. */
export function examSourcesIncluded(value: unknown, sources: Set<unknown>, catalogRecord = false): boolean {
  if (Array.isArray(value)) return value.every(item => examSourcesIncluded(item, sources, catalogRecord));
  if (!isRecord(value)) return true;
  return Object.entries(value).every(([key, child]) => {
    if (["workSourceId", "referenceSourceId", "packSourceId", "sourceId"].includes(key)) {
      if (catalogRecord && key === "sourceId" && !isUuid(child)) return true;
      return child == null || sources.has(child);
    }
    return examSourcesIncluded(child, sources, key === "sourceRecords");
  });
}

export function backupAssetAdmission(tables: Tables) {
  const index = (name: string) => new Map((tables[name] ?? []).map(row => [row.id, row]));
  const sources = new Set(index("opening_sources").keys()), chunks = index("opening_source_chunks");
  const courses = index("courses"), documents = index("library_documents"), blocks = index("library_blocks");
  const sprints = index("opening_exam_sprints"), attempts = index("opening_learning_attempts");
  const observations = index("opening_learning_observations"), links = index("opening_exam_attempt_links");
  const graphs = new Map((tables.opening_course_knowledge ?? []).map(row => [row.course_id, row]));
  const endpoint = (kind: unknown, id: unknown) => kind === "document" ? documents.has(id) : kind === "block" && blocks.has(id);
  const sameOwner = (row: Row, parent?: Row) => !!parent && row.workspace_id === parent.workspace_id
    && row.owner_user_id === parent.owner_user_id;
  return (name: AssetTable, row: Row): boolean => {
    if (name === "library_documents") return true;
    if (name === "library_relations") return endpoint(row.from_type, row.from_id) && endpoint(row.to_type, row.to_id);
    if (name === "library_properties") return endpoint(row.subject_type, row.subject_id);
    if (name === "library_blocks" || name === "library_revisions") return documents.has(row.document_id);
    if (name === "opening_note_provenance") return documents.has(row.document_id) && Array.isArray(row.context_source_refs)
      && !!sourceReferences(row)?.every(id => sources.has(id));
    if (!isUuid(row.owner_user_id) || row.course_id != null && !courses.has(row.course_id)) return false;
    if (name === "opening_course_knowledge" || name === "opening_knowledge_confirmations") {
      if (!isRecord(row.source_versions) || !sourceReferences(row)?.every(id => sources.has(id))) return false;
      if (name === "opening_knowledge_confirmations") return sameOwner(row, graphs.get(row.course_id))
        && Array.isArray(row.evidence_chunk_ids) && row.evidence_chunk_ids.length > 0 && row.evidence_chunk_ids.every(id => chunks.has(id));
      const graph = knowledgeSnapshotSchema.safeParse(row.snapshot);
      return !("node_definitions" in row) && graph.success && graph.data.courseId === row.course_id
        && graph.data.nodes.every(node => node.courseId === row.course_id)
        && [...graph.data.nodes, ...graph.data.edges].every(item => item.evidenceChunkIds.every(id => chunks.has(id)));
    }
    if (!examSourcesIncluded(row, sources)) return false;
    if (name === "opening_exam_sprints") {
      if (!isRecord(row.pack_snapshot) || !isRecord(row.state)) return false;
      if (row.course_id == null) return typeof row.pack_snapshot.id === "string" && typeof row.pack_snapshot.version === "string"
        && Object.keys(row.pack_snapshot).every(key => key === "id" || key === "version");
      const pack = courseExamSnapshotSchema.safeParse(row.pack_snapshot);
      return Object.keys(row.state).length === 0 && pack.success && pack.data.requests.every(request => request.proposal === null && request.status !== "pending");
    }
    if (name === "opening_exam_help_receipts") return sameOwner(row, links.get(row.attempt_link_id));
    if (!sameOwner(row, sprints.get(row.sprint_id))) return false;
    if (name === "opening_exam_bindings") return isRecord(row.binding) && row.binding.courseId === row.course_id;
    if (name === "opening_exam_papers") return sources.has(row.source_id);
    if (name === "opening_exam_reviews") return sources.has(row.work_source_id) && sources.has(row.reference_source_id);
    if (name === "opening_exam_attempt_links") return sameOwner(row, attempts.get(row.learning_attempt_id))
      && (row.observation_id == null || sameOwner(row, observations.get(row.observation_id)));
    if (name === "opening_exam_source_observations") return sameOwner(row, observations.get(row.observation_id));
    return true;
  };
}

export function validateBackupWorkspaceAssets(tables: Tables, errors: string[], owner?: string) {
  const admitted = backupAssetAdmission(tables);
  const generated = (row: Row) => isRecord(row.generation_config) && isRecord(row.generation_config.extras)
    && row.generation_config.extras.kind === "course_exam";
  if (tables.opening_teaching_activities?.some(row => isRecord(row.create_intent) && row.create_intent.kind === "course_exam")
    || tables.opening_teaching_units?.some(generated) || tables.opening_teaching_activity_specs?.some(generated)) {
    errors.push("Private generated exam publications cannot be restored from a learner backup");
  }
  const docs = tables.library_documents && new Set(tables.library_documents.map(row => String(row.id).toLowerCase()));
  for (const name of ["opening_teaching_units", "opening_teaching_activity_specs"]) {
    if (tables[name]?.some(row => !isUuid(row.document_id) || (docs && !docs.has(row.document_id.toLowerCase())))) {
      errors.push(`${name} references a missing library document`);
    }
    if (owner !== undefined && tables[name]?.some(row => row.owner_user_id !== owner)) errors.push(`${name} owner mismatch`);
  }
  for (const name of [...LIBRARY_BACKUP_TABLES, ...COURSE_BACKUP_TABLES]) {
    const identities = new Set<string>();
    for (const row of tables[name] ?? []) {
      const parts = primaryKeys[name].map(key => row[key]);
      const identity = JSON.stringify(parts);
      if (parts.some((value, i) => i === 0 ? !isUuid(value) : typeof value !== "string" || !value)
        || identities.has(identity) || !admitted(name, row)
        || owner !== undefined && (COURSE_BACKUP_TABLES as readonly string[]).includes(name) && row.owner_user_id !== owner) {
        errors.push(`${name} has an invalid identity, owner or asset reference`);
      }
      identities.add(identity);
    }
  }
}
