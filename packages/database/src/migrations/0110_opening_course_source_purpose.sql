-- Course-local source purpose; existing NULL rows remain explicitly unclassified.
-- Requires the real 0109 migration in the contiguous migration chain.
ALTER TABLE course_asset_memberships
  ADD COLUMN purpose text NULL,
  ADD CONSTRAINT course_asset_memberships_source_purpose_check CHECK (
    purpose IS NULL OR (
      asset_type = 'source'
      AND purpose IN ('teaching', 'practice', 'mock_exam', 'reference')
    )
  );

-- Forward-only additive change: no source, attempt, answer or exposure is rewritten.
-- Rollback: revert application code first; retain this nullable column and its data.
-- Dropping the column would discard user classifications and needs separate approval.
