/** Server authority, queues and private content never travel through learner archives. */
export const BACKUP_FORBIDDEN_TABLES = Object.freeze([
  "schema_migrations", "users", "sessions",
  "opening_connections", "opening_connection_credentials", "opening_connection_credential_requests",
  "opening_model_providers", "opening_model_provider_models", "opening_model_provider_credentials",
  "opening_jobs", "opening_tutor_jobs", "opening_outbox", "opening_import_cursors", "opening_import_receipts",
  "opening_parser_health", "opening_pdf_parse_segments", "opening_explicit_regrade_requests",
  "opening_budget_reservations", "opening_budget_reconcile_events", "opening_parent_interaction_budgets",
  "opening_course_reserved_questions", "opening_course_question_exposures", "opening_course_question_exposure_coverage",
  "opening_ephemeral_provenance", "opening_query_ephemeral_provenance", "opening_assistant_proposals",
  "opening_exam_sprint_commands", "opening_exam_integration_commands", "opening_measurement_commands",
  "opening_measurement_trials", "opening_measurement_attempts", "opening_dataset_consents",
  "opening_learning_eligibility", "opening_source_visual_recognitions", "opening_action_digest_decisions",
  "practice_item_versions", "practice_items", "practice_sessions", "revision_proposals",
] as const);

export function isForbiddenBackupTable(name: string): boolean {
  return (BACKUP_FORBIDDEN_TABLES as readonly string[]).includes(name);
}

/** Inspect table namespaces before a wire parser strips unknown properties.
 * User-authored record values can contain arbitrary JSON keys. */
export function findForbiddenBackupTable(packed: unknown): string | undefined {
  if (!packed || typeof packed !== "object") return;
  const bundle = packed as Record<string, unknown>;
  for (const namespace of [bundle, bundle.records, bundle.tables, bundle.counts]) {
    if (namespace && typeof namespace === "object") {
      const name = Object.keys(namespace).find(isForbiddenBackupTable);
      if (name) return name;
    }
  }
  const manifest = bundle.schemaManifest as { tables?: unknown } | null | undefined;
  if (Array.isArray(manifest?.tables)) return manifest.tables.find(name => typeof name === "string" && isForbiddenBackupTable(name));
}

/** Additive inventories may be absent from existing version-one packages. */
export const LIBRARY_BACKUP_TABLES = [
  "library_documents", "library_blocks", "library_revisions", "library_relations", "library_properties",
  "opening_note_provenance",
] as const;

export const COURSE_BACKUP_TABLES = [
  "opening_course_knowledge", "opening_knowledge_confirmations", "opening_exam_sprints", "opening_exam_bindings",
  "opening_exam_papers", "opening_exam_reviews", "opening_exam_source_mappings", "opening_exam_attempt_links",
  "opening_exam_source_observations", "opening_exam_help_receipts",
] as const;
