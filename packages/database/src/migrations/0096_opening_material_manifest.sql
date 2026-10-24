-- OPT-03: version-pinned role/page/question/answer metadata reuses retained source versions.
-- No source bytes, existing question IDs or learner history are rewritten.
ALTER TABLE opening_source_versions
  ADD COLUMN material_manifest jsonb,
  ADD COLUMN material_manifest_revision integer NOT NULL DEFAULT 0 CHECK (material_manifest_revision >= 0),
  ADD COLUMN material_reviewed_by uuid REFERENCES users(id),
  ADD COLUMN material_reviewed_at timestamptz,
  ADD CONSTRAINT opening_source_material_manifest_object CHECK
    (material_manifest IS NULL OR jsonb_typeof(material_manifest)='object');

-- Rollback: stop material-manifest writers and teaching/retrieval/grading consumers,
-- retaining these columns, source versions and paid ledgers. A pre-0096 reader does
-- not enforce restricted answer sections: do not enable it on classified materials.
-- Restore application compatibility before reopening learning; no DROP/backfill that
-- removes disputed status or exposes answer text is an acceptable down migration.
