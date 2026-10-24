-- 0096 adds an optional reviewer pointer to retained source-version history.
-- Version rows deliberately outlive sources/workspaces for provenance; this
-- pointer must not block account deletion. Per-answer historical audit remains
-- in the retained manifest JSON, without granting authority to a deleted user.
ALTER TABLE opening_source_versions
  DROP CONSTRAINT opening_source_versions_material_reviewed_by_fkey,
  ADD CONSTRAINT opening_source_versions_material_reviewed_by_fkey
    FOREIGN KEY(material_reviewed_by) REFERENCES users(id) ON DELETE SET NULL;

-- Application rollback retains this non-blocking FK and existing histories.
-- Do not restore NO ACTION or delete source versions to make account cleanup pass.
