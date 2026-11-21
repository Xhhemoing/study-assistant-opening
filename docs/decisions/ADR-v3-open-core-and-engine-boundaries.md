# ADR v3.0 Open-Core and Engine Boundaries

- Status: proposed for v3.0 Open-Core review
- Date: 2026-11-20
- Scope: package layering, public candidate exports, and community-edition extraction

## Decision

AIstudy v3.0 uses a clean-room, one-way dependency DAG. Public candidates may depend on
stable contracts and portable domain primitives, while commercial engine modules remain
outside every public export surface and community-edition artifact.

The intended package direction is:

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

The following surfaces are the Apache-2.0 open-core引流层. They are deliberately narrow
and host-agnostic.

- `@aistudy/jingwei` at `.` and `./react` provides the presentation artifact, renderer,
  planner, and restricted host-capability boundary. It does not contain the server-side
  rules witness producer.
- `@aistudy/domain/native` provides lossless backup and portable pure-function
  primitives.
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
- L3-L4 flagship cartridges and the `SeededRecipe` rational-variant generator,
  including `span-*` and `exam-sprint` assets, remain private.
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

`scripts/export-community-edition.ts` follows six steps. Each step is fail-closed and
operates on a fresh source candidate.

1. Read the exact candidate commit and enumerate the allowlisted public entry files.
2. Walk the module graph with the TypeScript AST, including static imports, named and
   star re-exports, dynamic imports, `require`, type-only edges, workspace packages,
   and package `imports` aliases.
3. Reject any graph that reaches a closed-core or server-only target. Do not infer safety
   from a successful health check, a generated bundle, or an unresolved alias.
4. Export only Git blob contents in the allowlist. Do not copy the private `.git`
   directory, historical refs, or unlisted blobs.
5. Create an independent Community migration chain and lock file. No private migration,
   fixture, seed, or historical reference is carried over.
6. Return honest capability statuses. L3-L4 operations return `unsupported_level` or
   `unavailable` and never claim a public implementation.

The extractor is not a history filter. A candidate must be safe at the graph boundary
before its allowlisted blobs are copied.

## Enforcement

The contract gate in `tests/contract/v3-open-core-boundary.test.ts` is the executable
interpretation of this decision. It scans the existing public candidates
`packages/jingwei/src/index.ts`, `packages/jingwei/src/react/index.ts`, and
`packages/domain/src/portability/native/index.ts`. If any planned public candidate
appears in the repository, the gate includes it automatically.

The analyzer resolves relative paths, workspace package names, package export entries,
and package `imports` mappings. It follows runtime and type-only edges and records a
complete entry-to-target chain. The gate also exercises in-memory positive and negative
module graphs for multi-layer re-exports, dynamic imports, server packages, private
`#*` aliases, and closed-core type re-exports. These fixtures do not write temporary
repository files.

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
