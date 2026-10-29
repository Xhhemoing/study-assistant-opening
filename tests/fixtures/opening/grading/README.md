# Offline grading evaluation

Run from the repository root (no provider, network or database call):

```bash
node --import tsx scripts/study-grading-eval.ts \
  --dataset tests/fixtures/opening/grading/objective-arithmetic.json \
  --results tests/fixtures/opening/grading/objective-synthetic-run.json
```

`objective-arithmetic.json` contains eight development examples with explicit correct/incorrect labels for rational arithmetic. Labels are `program_verified` using `exact-arithmetic-v1`; evaluation recomputes each label with BigInt rational arithmetic and rejects unsupported or conflicting labels. This is not human review. The parser covers unit-free decimal/fraction arithmetic, parentheses and equality chains. It does not establish completion of a proof, word problem, units, approximate answers or a general mathematical derivation.

`objective-synthetic-run.json` contains synthetic outputs, including one deliberate false correct and one deliberate false incorrect. It demonstrates that the raw model error remains visible when the accepted policy abstains. Its `test_fixture` provenance must remain intact; its scores are not model performance. It also exercises the same arithmetic checker used by the acceptance policy, so this is a development regression dataset, not an independent semantic benchmark.

`review-candidates.json` contains twelve pending assistant-authored candidates across six error groups. Pending labels never count as scoring truth. A human review must identify the reviewer, time, outcome and rationale before changing a case to `human_reviewed`; do not promote a candidate because a model agrees with it. Photo cases additionally need an immutable image evidence reference and an actual matching result. The scorer compares captured image references but does not inspect image files or certify that a provider received them.

For a real run, capture each case's exact input, case version and raw grading JSON in the `gradingEvaluationRunSchema` format, with an explicit model label, completion time and `real_provider` provenance. Never relabel the synthetic file as a provider run. Versions and inputs must match the dataset; missing, malformed or mismatched results remain in the coverage denominator. Results preserve raw outcomes and accepted outcomes separately, show false correct/incorrect and unsafe binary judgments on unjudgeable cases, and separate human-reviewed from program-verified metrics. Confidence is an uncalibrated model self-report and is never treated as accuracy.

Reports retain the existing `coverage`, `acceptedAccuracy` and error counts. `acceptedAccuracy` describes only accepted binary decisions; it can be perfect when almost every answer is left ungraded. Read it together with `expectedCounts` and `decisionRates`, available in the summary, error-group and review-source breakdowns. Each decision rate includes its `numerator`, `denominator`, `rate` and `upper95`: the one-sided 95% Clopper–Pearson exact binomial upper confidence bound, not a two-sided interval. Zero-denominator rates and bounds are `null`, not zero. Zero observed errors do not imply zero population risk. These finite-sample bounds assume binomial sampling; this synthetic, non-independent development set does not establish real-world generalization or a release gate.

| `decisionRates` field | Numerator | Denominator |
| --- | --- | --- |
| `falseCorrectOnIncorrect` | Incorrect student answers judged correct | All reviewed incorrect answers |
| `falseIncorrectOnCorrect` | Correct student answers judged incorrect | All reviewed correct answers |
| `binaryCoverageOnGradeable` | Correct/incorrect decisions on gradeable answers | All reviewed correct or incorrect answers |
| `abstentionOnGradeable` | Explicit `unverified` decisions on gradeable answers | All reviewed correct or incorrect answers |
| `missingOrInvalidOnGradeable` | Missing, malformed or mismatched results on gradeable answers | All reviewed correct or incorrect answers |
| `correctAbstentionOnUnverifiable` | Explicit `unverified` decisions where no reliable judgment is possible | All reviewed answers labelled `unverified` |
| `unsafeBinaryOnUnverifiable` | Correct/incorrect decisions where no reliable judgment is possible | All reviewed answers labelled `unverified` |
| `missingOrInvalidOnUnverifiable` | Missing, malformed or mismatched results where no reliable judgment is possible | All reviewed answers labelled `unverified` |

The corresponding `rawModel.decisionRates` uses the same class denominators before the acceptance policy and arithmetic corroboration. Pending candidates never enter these denominators. Missing/invalid results are a separate category, not abstentions or successful handling. Consequently, the binary coverage, abstention and missing/invalid rates partition gradeable cases; the correct abstention, unsafe binary and missing/invalid rates partition unverifiable cases. Error incidence rates include missing results in their class denominators and must be interpreted alongside these coverage and failure rates, not as evidence that an unprocessed answer was correctly graded.

Use `--output NEW_FILE` to create a private report; the script refuses to overwrite an existing file. No reports or scores are imported into learning history. Human semantic labels, real provider runs, photo verification and delayed learning outcomes remain to be collected.

## Explicit model collection (text only)

`study-grading-collect.ts` collects outputs through the existing grading prompt and OpenAI-compatible provider adapter. It requires an explicit model, environment-variable names for the endpoint/key, a request limit and a new output path. After configuring those environment variables, an operator can run:

```bash
node --import tsx scripts/study-grading-collect.ts \
  --dataset tests/fixtures/opening/grading/review-candidates.json \
  --model YOUR_MODEL \
  --source-commit YOUR_SOURCE_COMMIT \
  --instruction-version YOUR_INSTRUCTION_VERSION \
  --rubric-version YOUR_ACCEPTANCE_RUBRIC_VERSION \
  --protocol-version grading-evaluation-v1 \
  --base-url-env STUDY_GRADING_BASE_URL \
  --api-key-env STUDY_GRADING_API_KEY \
  --max-requests 2 \
  --output /absolute/private/path/grading-run.json
```

There are no default credentials, model or request budget. Calls are serial, limited to 1–1000 HTTP request attempts, with no retries or fallback models; `--timeout-ms` optionally sets a 1000–120000 ms deadline (default 30000 ms). Requests that enter the transport count toward the limit even if the network fails. The collector uses the existing guarded provider transport. It calls that adapter directly, without an application database or per-user billing ledger: the explicit request/token bounds limit the run, not its monetary cost. It sends only the question, student answer and reference text, never candidate labels, review outcomes, reviewer identities or review rationales.

Run metadata is required: `sourceCommit`, `instructionVersion`, `rubricVersion`, `protocolVersion`, and `promptDigest`. The CLI requires explicit source/instruction/acceptance-rubric/protocol labels; operators must identify the actual checkout (including local changes if any), not an unrelated clean commit. The collector computes `promptDigest` as `sha256:<hex>` over the UTF-8 `ProviderInput.instruction` built by the existing grading builder and reused for text requests. It does not hash outputs, candidate labels, or student data. This digest identifies the grading instruction, not the provider adapter's surrounding system envelope or a probability calibration. Protocol mismatches are rejected before requests. Reports preserve all metadata; legacy files missing fields are rejected, never filled from current versions. The existing synthetic fixture explicitly uses `unknown` for unavailable historical source/instruction/rubric/digest values and retains `test_fixture` provenance; its known dataset protocol is recorded explicitly. No provider was called to migrate that fixture.

The first version does not read or transmit photo assets. Every photo case remains in the output with `photo_not_supported` in the sidecar, even if an image reference exists. Cases after the request limit, request failures and malformed output also remain in the output; they do not vanish from evaluation denominators. Only successfully decoded provider output enters the evaluation run. A valid-looking grading message rejected by the provider envelope stays a failed result, even when its original content looks correct.

The result file follows `gradingEvaluationRunSchema` and can be passed to `study-grading-eval.ts --results`. `<output>.collection.json` records case status and request count. Both files are created exclusively with owner-only permissions and checkpointed after each case. Existing files and dataset inputs are never overwritten; stdout prints counts only. Outputs contain private student material and should stay in a private directory. An interrupted sidecar stays `in_progress`; no automatic resume or resend occurs, so inspect it before explicitly starting another run that may repeat a paid request.

The adapter validates the provider envelope and returns its production-decoded `output.text` for `run.results.rawOutput`. For example, JSON fences accepted by production are normalized before scoring. The original `message.content` is retained separately in sidecar `rawMessageContent`, bounded to 80000 characters with the full original length in `rawMessageLength`. Each case also records the provider's validated `requestId`, `inputTokens` and `outputTokens` when supplied (otherwise `null`), plus elapsed request duration; collection `elapsedMs` is overall elapsed wall time, not first-token time. No monetary cost is inferred without prices.

Fixture-injected transports are always labelled `test_fixture`; a configured live transport is labelled `real_provider`, which identifies collection provenance, not human review, calibrated accuracy or measured learning effects. The tests use fixture transports only; no real paid-model run is implied by this collector's implementation.
