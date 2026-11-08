# Historical confirmation-recovery test artifacts

Test-only source snapshots from `Xhhemoing/study-assistant-opening`:

- `108`: `996fc1d8623ae106c8dd0f5379fe533b9bb4efee` — real compatibility anchor, complete migration inventory 0001–0108.
- `109`: `e2b9166adeb790e6a5f63520389aa38d7c69199a` — real frozen private-question candidate, complete inventory 0001–0109. Its three control files are byte-identical to 108 and reuse those fixtures.

The manifests were generated once from these exact Git objects. They record the formal repository, full commit, control-file SHA-256 digests, runtime support-file digests and fixed SQL filenames/digests. The 109 manifest references the complete 108 inventory and adds only the actual 0109 SQL filename/digest. Raw controls use their original relative paths with `.bin` appended solely to identify inert test data; materialization restores the original filenames. No SQL is duplicated here.

`tests/integration/migration-order.test.ts` verifies the committed manifest bytes, source provenance, raw controls and checkout canonical SQL against these digests before materializing temporary artifacts. Missing historical files, duplicate historical slots and changed bytes fail. Later checkout migrations are not copied into a historical artifact; the **unfiltered current checkout** is separately required to fail the old recovery profile. Runtime package metadata and `migration-preflight.ts` are copied only after their historical digests match; dependencies are linked only for temporary test execution.

The test never invokes Git, fetches history or requires non-shallow checkout history. It applies real historical SQL in an isolated test schema, checks read-only ledger equality, accepts the real 108 artifact only under its original anchor, rejects the real 109 artifact/current checkout, and verifies that an actual applied 0109 is unknown to the old anchor. One-byte mutation tests cover stored control/manifest and canonical SQL bytes.

These files do not authorize recovery, migration execution or deployment. The production recovery profile remains fixed at 0108; there is no new profile, checksum repair, fabricated ledger, skipped migration or allow-unknown behavior. Fixtures contain no environment files, credentials or connection details.
