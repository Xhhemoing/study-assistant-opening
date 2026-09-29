-- Assistant provenance is known only when the complete consumed context was captured.
-- Legacy rows remain NULL; an empty array is an explicitly known source-free context.
ALTER TABLE opening_turns ADD COLUMN context_source_refs jsonb;
ALTER TABLE opening_turns ADD CONSTRAINT opening_turns_context_source_refs_array_check
  CHECK (context_source_refs IS NULL OR jsonb_typeof(context_source_refs) = 'array');
