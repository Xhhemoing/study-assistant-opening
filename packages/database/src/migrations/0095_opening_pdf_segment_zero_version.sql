-- OPT-02a correction: beginUpload -> completeWithParseJob retains source version 0.
-- Preserve the already-applied 0094 file/checksum and all existing cache rows.
ALTER TABLE opening_pdf_parse_segments
  DROP CONSTRAINT opening_pdf_parse_segments_source_version_check,
  ADD CONSTRAINT opening_pdf_parse_segments_source_version_check CHECK (source_version >= 0);

-- Application rollback: stop/drain parser workers first; retain 0094/0095 history,
-- this nonnegative constraint and cached pages. Do not restore >= 1 or delete
-- version-0 sources/cache to make a down migration pass (see parser README).
