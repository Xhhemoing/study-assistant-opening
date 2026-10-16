-- Preserve the target requirement when accepting an adaptive suggestion.
-- Historical tasks remain unattributed; do not infer a requirement from their label.
ALTER TABLE opening_tasks ADD COLUMN requirement_key text;

-- Roll back the application first. Keep this nullable column to preserve accepted
-- task identity. Export requirement_key before any intentional schema rollback:
-- ALTER TABLE opening_tasks DROP COLUMN requirement_key;
