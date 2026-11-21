# ADR v3.0 Open-Core and Engine Boundaries

- Status: proposed engine boundaries with the license decision approved on 2026-11-20
- Date: 2026-11-20
- Scope: package layering, public candidate exports, and community-edition extraction

## Decision

AIstudy v3.0 uses a clean-room, one-way dependency DAG. Public candidates may depend on
stable contracts and portable domain primitives, while commercial engine modules remain
outside every public export surface and community-edition artifact.

The intended package direction includes the planned `apps/cli`:

```text
apps/{web,worker,cli}
  -> (@aistudy/ai || @aistudy/database || @aistudy/jingwei || @aistudy/ui)
  -> @aistudy/domain
  -> @aistudy/contracts
```

`@aistudy/ai` and `@aistudy/database` are peers and must not depend on one another. The
current repository contains an eight-file compatibility dependency from
`@aistudy/database` to `@aistudy/ai`. The in-flight repository changes associated with
PRs #460, #469, and #474 will remove that dependency in one coordinated migration. That
migration is the single compatibility contract for the eight affected repository files.
This ADR does not authorize changing those files or the dependency graph ahead of that
migration.

The DAG constrains imports, re-exports, dynamic imports, `require` calls, package
subpaths, package `imports` aliases, generated declarations, and type-only public
exports. A public candidate is accepted only when its complete transitive module graph
contains zero closed-core or server-only targets.

## Apache-2.0 open-core public candidates

The following entry points are candidates for the Apache-2.0 Community
Edition. Each candidate must pass the transitive graph check before extraction.

- `@aistudy/jingwei` at `.` and `./react` provides the presentation artifact, renderer,
  planner, and restricted host-capability boundary. It does not contain the server-side
  rules witness producer.
- `@aistudy/domain/native` provides pure-data backup and restore operations for Node
  and CLI hosts, including in-memory hashing and binary encoding.
- The planned `@aistudy/contracts/learner-portability` subpath contains portable
  learner contracts.
- The planned `@aistudy/contracts/cartridge-lite` subpath contains the lite cartridge
  contract.
- The planned `@aistudy/domain/cartridge-sdk-lite` subpath contains only lossless
  Markdown, Obsidian, Anki, and ZIP import/export, a basic `ts-fsrs` wrapper, and the
  L1-L2 introductory open-question package specification.

The `#469` complete `./opening/cartridges` bucket bundles STACK cartridges and evidence
gates. It is not a permissive open-source entry point and must not be treated as one.
Open candidates may use `zod`, `ts-fsrs`, `@aistudy/contracts` public modules, and other
explicitly portable dependencies. They must not acquire a private dependency through a
helper, barrel, declaration, or lazy path.

### Candidate runtime profiles

Each entry's profile applies to its entire transitive graph, including shared helpers
and declarations. Both profiles reject commercial engines, private cartridges, and
hosted service packages, including database clients, AI services, and Next.js modules.

- **`browser-ui`** covers Jingwei and open UI components. It rejects all Node
  built-ins in both prefixed and bare form. The UI entry also uses the allowlisted
  Radix Dialog, Tabs, and Toast packages and Lucide React icons.
- **`portable-runtime`** covers native backup and restore, the contracts entry,
  the cartridge SPI, and the lite cartridge SDK. It allows exactly two Node module
  specifiers, `node:crypto` and `node:buffer`, for in-memory processing. Bare
  `crypto` and `buffer`, filesystem, process, network, and other Node built-ins
  remain prohibited. This is a module-level check.

`packages/domain/src/browser-boundary.test.ts` checks the domain browser entry, and
`scripts/check-server-boundary.mjs` checks client imports for server dependencies.

## 100% closed-core commercial moat

The following implementation areas are closed core and must never enter a public export
surface, public package graph, portable export, vector index, or community edition.

- `packages/domain/src/epistemic/**` contains `SkillBeliefV1` with three-point
  Gauss-Hermite estimation, Tier 0/1/2 cold-start limits, triple `FIRe` gating with
  `c <= ln(1.2)`, prompt `omega = 0`, and pre-exam 72-hour Bellman scheduling.
- `packages/domain/src/symbolic-equivalence/**` contains Sturm domain isolation,
  quadratic radicals, antiderivative residuals, linear-algebra subspace rank
  equalities, and the 408 restricted typed C bytecode interpreter.
- `packages/domain/src/pedagogical-retrieval/**` contains `public | hint_gated |
  sealed` discourse AST pre-splitting and sparse approximately 15-line PPR retrieval.
- `packages/ai/src/tutor-graph/**` contains the four-node `TutorGraph`, Min-Entropy
  prompt-budget pre-deduction, and the deterministic sub-550ms Socratic fast path.
- `packages/ai/src/cartridge-compiler/**` contains the Stage-0 768-turn student
  simulator, the GEPA `(C, -L, T7)` Pareto compiler, and
  `AnchorCalibratedRubricV1` position-swap anchor calibration.
- Wave P reserves `packages/domain/src/diagnostic-placement/**`,
  `packages/domain/src/remedy-clinic/**`, and `packages/domain/src/exam-forecast/**`
  for the commercial diagnostic, remediation, and forecasting engines.
- Wave P also reserves `packages/ai/src/rubric-calibration/**` for commercial rubric
  calibration.
- L3-L4 flagship cartridges and the `SeededRecipe` rational-variant generator,
  including `stack-408-v1`, `ielts-writing-speaking-v1`, `span-*`, and
  `exam-sprint` assets, remain private.
- The `0109` reserved exam-question vault, `0113+` `btree_gist` bitemporal error
  memory, and the Wave R margin and privacy controls remain private. The Wave R controls
  include the millionth-precision three-ledger guard, bilateral privacy gate
  `E >= 5 & N-E >= 5`, offline 12-hour lease, scanned scratch paper, 15-minute drift
  sentinel, and envelope-encryption erasure.

Closed-core classification applies through aliases and transitive paths. A package name,
relative path, `#*` import alias, type-only edge, dynamic import, or `require` call does
not become public merely because its immediate caller is public.

## Kerckhoffs three laws

The boundary follows three independent laws.

1. **Material safety**. The private `0109` question bank and all `sealed` content never
   enter browser payloads, portable exports, vector indexes, or PPR graph nodes and
   edges.
2. **Runtime authority**. The `Respond` node receives only `PublicTeachingCaps`. It has
   no verifier, database, or raw-tool handle.
3. **Billing authority**. Server-side settlement uses three independent ledgers with
   idempotent pre-deduction and settlement. BYOK never silently falls back to a platform
   key.

A violation of one law is a boundary failure even when the other two remain intact.

## Community extraction protocol

The planned `scripts/export-community-edition.ts` will operate on a fresh candidate
commit and stop on any failed step.

1. Read the exact candidate commit and enumerate the allowlisted public entry files.
2. Walk the module graph with the TypeScript AST, including static imports, named and
   star re-exports, dynamic imports, `require`, type-only edges, workspace packages,
   and package `imports` aliases.
3. Reject closed-core and server-only targets, nonliteral module specifiers, unresolved
   edges, and external imports outside the explicit portable allowlist. Inspect every
   target of each matching conditional export or import.
4. Export only Git blob contents in the allowlist. Do not copy the private `.git`
   directory, historical refs, or unlisted blobs.
5. Generate the public package manifests and Apache-2.0 `LICENSE` in the independent
   Community Edition. Create its migration chain and lock file there. Exclude private
   migrations, fixtures, seeds, and historical references.
6. Return honest capability statuses. L3-L4 operations return `unsupported_level` or
   `unavailable` and never claim a public implementation.

The extractor is not a history filter. A candidate must be safe at the graph boundary
before its allowlisted blobs are copied.

## Private and Community Edition licenses

On 2026-11-20 the project owner approved separate licensing for the two repositories.
When Lane N0-Decouple releases the shared manifest lock, the private repository's root
`package.json` will switch from `AGPL-3.0-only` to `"license": "UNLICENSED"`.
Closed-core workspace manifests will explicitly declare `UNLICENSED` as part of the
same change. The manifest edits belong to that lane.

Only the planned extractor may generate the Apache-2.0 `LICENSE` and public
`package.json` files while exporting allowlisted Git blobs into the independent
Community Edition repository. It must check the generated root manifest and the
manifest governing each reachable source file for `"license": "Apache-2.0"`.
The private-source scan checks dependencies before extraction. The export scan also
checks licenses, so a missing license or an `UNLICENSED` manifest blocks publication.

## Enforcement

The contract gate in `tests/contract/v3-open-core-boundary.test.ts` is the executable
interpretation of this decision. It scans both Jingwei entries and the UI entry under
`browser-ui`. It scans the native backup and contracts entries under `portable-runtime`.
The cartridge SPI, lite SDK entries, and the two planned contracts subpaths join the
portable scan when their source or package export appears. Each candidate must provide
a readable source file and a resolvable public package entry. For example, the Jingwei
React scan starts from both its source file and every target of the package's
`./react` export. Public package roots also contribute their legacy entry fields.
Export still requires a separate blob allowlist.

The analyzer checks that each selected entry is a readable file, then follows runtime
and type-only edges across workspace packages and local modules. CommonJS calls to
`require`, `module.require` and `module["require"]` follow the same rules. Triple-slash path
references resolve relative to the declaring file. Ambient type directives resolve
through in-repository `node_modules/@types` declarations, including their transitive
references. The pinned TypeScript compiler parses every `typesVersions` selector in ambient packages,
workspace packages, and relative directory imports. It scans unversioned declarations
and every matching replacement. For workspace and directory entries, a mapping can
match the declared runtime filename, its declaration filename, or its extensionless name.
Package roots without `main`, `types` or `typings` also query `index`.
Each replacement must resolve to a declaration inside its package. Runtime allowlists
apply only to module imports.

Directory resolution checks root export conditions, legacy entries, browser mappings,
and existing index files. Runtime targets require an implementation, and the gate also
scans any paired declarations. Missing entries and directory entry cycles fail the check.
Before reading disk files or manifests, the analyzer resolves links within the real
repository root. It checks both the requested path and its destination for closed-core
content and, during export, for the owning package's license. A linked file's outgoing
edges resolve from both its requested directory and its physical directory. A plain
lookup miss, including an unmapped package import such as `#helper`, can be satisfied
by the other directory. Broken links, invalid manifest entries and boundary violations
from either directory fail the check. The gate matches exact subpaths before wildcard
patterns and reports the chain to each violation. Relative `imports` and `exports`
targets must stay inside the owning package on both the requested and resolved paths.
The in-memory cases cover mixed public and private conditional branches, alias cycles,
Node built-ins, Wave P directories, dynamic calls, declaration files, and private
manifests in an export candidate. The `requirePermissiveCandidateLicense` option selects
the Community Edition license check.

A zero-violation result is necessary for the public candidate graph. It does not certify
private server behavior, billing, migrations, deployment, or real-account acceptance.
Those concerns retain their own owners and gates.

## Consequences

The public surface stays small enough to audit and reproduce independently. Internal
engine changes can proceed behind the boundary without expanding the Apache-2.0
contract. Contributors receive portable capabilities and truthful unsupported statuses,
while private teaching, retrieval, equivalence, scheduling, cartridge, exam, and billing
logic remains inaccessible through direct or indirect exports.

Any future public subpath requires a new entry file, package export decision, and a
passing transitive graph gate. It must preserve the one-way DAG and the three Kerckhoffs
laws.
