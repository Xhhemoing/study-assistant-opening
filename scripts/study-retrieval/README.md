# Material retrieval ablation

Run the existing owner-scoped material reader against a fixed, explicitly versioned corpus and query → relevant chunk-ID judgments. The runner compares the existing literal `ILIKE` lookup with an **evaluation-only** variant that adds declared glossary aliases and source/page context, then merges its query lists with reciprocal-rank fusion (`1 / (60 + rank)`). Relevant IDs never influence retrieval. Production ranking and permissions are unchanged; no model or embedding is called.

```sh
node --import tsx scripts/study-retrieval-eval.ts \
  --fixture \
  --annotations tests/fixtures/opening/retrieval/rank-nullspace-annotations.json \
  --output /tmp/study-retrieval-fixture-report.json
```

The reproducible corpus reuses the repository's existing V2-02 rank/nullspace materials: five teaching sources, fourteen full page chunks, with definitions, examples, notation and cautions. The loader enforces their existing lecture allowlist. It does not read `eval-heldout/`, examples' answer keys, or student answers. These are already documented **synthetic teaching fixtures**; they are not production materials or student data. The fixture replay uses JavaScript literal matching as a compatibility adapter. Real PostgreSQL parity, ownership and version failures are covered by `tests/integration/opening-material-retrieval-evaluation.test.ts` and require the existing guarded test database.

For actual materials, provision `DATABASE_URL` through the normal environment, supply manually labelled current source/chunk identities, and omit `--fixture`:

```sh
node --import tsx scripts/study-retrieval-eval.ts \
  --annotations /private/annotated-material-queries.json \
  --output /private/material-retrieval-report.json
```

The command calls `readOpeningSystemQueryAuthorization` and `createScopedOpeningSystemQueryReader` using the supplied workspace and its owner. Each source/version must be accessible under that owner, uploaded, parsed and not excluded from AI use. It uses `system_record_lookup`: only metadata and chunk IDs are read into the report, with no excerpts or answer bodies, no exposure writes and no projection repair. Historical source versions that the production reader cannot access are reported as unavailable; they are never substituted with the latest version. Database connection strings and driver objects are never printed.

Use the checked-in annotation JSON as the protocol example, replacing its fixture scope, source IDs, versions, aliases and relevance labels. `annotationProvenance: "human_labeled"` records the operator's declaration, not a certification by the tool. Start with `relevantChunkIds: null` to obtain a scoped chunk inventory without claiming relevance, inspect the actual material in Study, and then provide the IDs that answer each query. Use `[]` only when a human has judged that no chunk in the declared corpus answers the query. Alias rules should come from a separate glossary; changing aliases after inspecting evaluation misses is development tuning and requires a fresh evaluation set before making performance claims.

The JSON report contains corpus chunk IDs and versions, every read's cutoff/version, expansion queries, both top-k ID lists, paired macro Recall@k and MRR@k, group metrics and evaluation coverage. Queries without judgments, labels outside the accessible inventory, unknown reader responses, permission changes, or corpus changes are **unable to judge**, not zero-recall failures. Empty relevance sets are reported separately. A source inventory beyond the existing reader's 1,000-offset window is also unjudgeable. Before/after inventory checks do not create one transactional snapshot; the report states that limit.

The development fixture has seventeen queries: fourteen positively judged, one judged unanswerable, one unlabelled and one deliberately unavailable label. It includes English, Chinese aliases, paraphrases and source/page context. Its scores only verify a runnable evaluation protocol. They do not justify semantic search, an alias policy for production, or claims about production retrieval quality. No production human labels or statistical calibration have been obtained by running the fixture.
