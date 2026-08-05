# Task 14 AI Roles and Provider-Neutral Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development and superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-neutral exploration conversation jobs with eight governed AI roles, schema-validated outputs, and provenance that can only produce candidates or proposals.

**Architecture:** `packages/contracts` owns the serializable job request, provider response, candidate, and provenance schemas. `packages/ai` owns role policy and a minimal provider adapter interface; it validates provider output before a job can return it. `apps/worker` owns a pure exploration-chat job that accepts a provider dependency and returns an auditable candidate-only result. No job receives a database repository or asset writer, so confirmed assets cannot be mutated by this slice.

**Tech Stack:** TypeScript, Zod, Vitest, npm workspaces, existing `@aistudy/contracts` and `@aistudy/ai` packages.

## Global Constraints

- Preserve existing `AIRole`, `ChatTurn`, and exploration contracts used by the mock Explore UI.
- Support exactly these roles: `retriever`, `explainer`, `tutor`, `challenger`, `editor`, `examiner`, `collaborator`, and `silent`.
- Provider output must be parsed with Zod before it leaves the job; malformed output is an explicit failure.
- Job results include routing identifiers (`jobId`, `explorationId`, and `role`), a reply, candidate note/card/question/task proposals, provenance, and `writeMode: "candidate_only"`; they must not expose an asset mutation callback or write to confirmed assets.
- Capture provider, model, prompt policy version, selected source IDs, provider-call status, request ID, cost, and timestamps in the result provenance; unknown provider metadata is `null`, never fabricated.
- Keep the implementation provider-neutral and deterministic under tests; do not add network calls, model SDKs, Redis/BullMQ wiring, database migrations, or UI in this slice.
- Use TDD: each behavior test must fail for the intended missing behavior before implementation.
- Do not create a git commit; the coordinator owns review and progress recording.

## File Map

- Create `packages/contracts/src/ai-jobs.ts`: request, provider response, candidate/proposal, provenance, and job result schemas/types.
- Modify `packages/contracts/src/index.ts`: export the AI job schemas and types.
- Create `packages/ai/src/roles.ts`: role policy table and lookup function.
- Create `packages/ai/src/providers/provider.ts`: provider request/response interface and response validator.
- Modify `packages/ai/src/index.ts`: export the role and provider APIs.
- Create `apps/worker/src/jobs/exploration-chat.ts`: provider-injected, candidate-only job processor.
- Modify `apps/worker/package.json`: add the workspace dependency on `@aistudy/ai`.
- Modify `apps/worker/tsconfig.json` only if workspace path resolution requires it.
- Create `packages/ai/src/roles.test.ts`: role completeness and policy invariants.
- Create `packages/ai/src/providers/provider.test.ts`: provider output validation behavior.
- Create `tests/integration/exploration-chat-job.test.ts`: job metadata, candidate-only output, silent role, and malformed provider output coverage without external services.

### Task 1: Contracts and role policy

**Interfaces:**

- `aiConversationJobRequestSchema` accepts `{ jobId, explorationId, role, input, selectedSourceIds, provider, model, promptPolicyVersion }` and optional `userId`.
- `aiCandidateSchema` accepts `{ kind: "note"|"card"|"question"|"task", title, body }`.
- `aiProviderResponseSchema` accepts `{ text, candidates }`, where `candidates` is an array of `aiCandidateSchema`.
- `aiJobProvenanceSchema` includes `provider`, `model`, `promptPolicyVersion`, `selectedSourceIds`, `requestId`, `costUsd`, `startedAt`, and `completedAt`.
- `aiConversationJobResultSchema` includes `jobId`, `explorationId`, `role`, `reply`, `candidates`, `provenance`, and literal `writeMode: "candidate_only"`.
- `rolePolicySchema` includes the role, a non-empty instruction, `allowSourceRetrieval`, `allowCandidateProposal`, and `allowFormalAssetMutation: false`.

- [ ] Add failing contract assertions for all eight roles, required provenance fields, candidate kinds, and rejection of `allowFormalAssetMutation: true`.
- [ ] Run `npx vitest run packages/ai/src/roles.test.ts packages/ai/src/providers/provider.test.ts tests/integration/exploration-chat-job.test.ts` and observe the expected missing-module/schema failure.
- [ ] Add the Zod schemas and inferred types while preserving existing exports.
- [ ] Run the focused contract/role tests and the contracts typecheck.

### Task 2: Provider-neutral adapter and role policies

**Interfaces:**

- `AIProvider.complete(request: AIProviderRequest): Promise<unknown>` is the only provider operation.
- `createProviderRequest(job): AIProviderRequest` derives role instruction, user input, and selected source IDs without adding a write capability.
- `validateProviderResponse(value): AIProviderResponse` returns parsed data or throws a named validation error.
- `getRolePolicy(role): RolePolicy` returns an immutable policy for exactly one supported role.

- [ ] Add failing tests for provider response rejection, candidate normalization, and immutable role policies.
- [ ] Implement the interface, policy table, request builder, and Zod-backed validator with no network or SDK imports.
- [ ] Run the package tests and `npx tsc -p packages/ai/tsconfig.json --noEmit`.

### Task 3: Worker exploration-chat job

**Interfaces:**

- `processExplorationChatJob(input: AIConversationJobRequest, provider: AIProvider, clock?: () => Date): Promise<AIConversationJobResult>`.
- The function calls `provider.complete` once for non-silent roles, validates the response, stamps request/cost/timestamps, and returns `writeMode: "candidate_only"`.
- The silent role returns an empty reply and candidate list without calling the provider.
- No function in this module accepts a database repository, asset writer, or confirmed asset ID.

- [ ] Add failing job tests for a normal role, silent role, malformed provider output, provenance propagation, and the absence of formal-asset writes.
- [ ] Add the minimal worker implementation and workspace dependency.
- [ ] Run the focused job test and worker typecheck.
- [ ] Run `git diff --check` and inspect the complete diff for accidental provider/network or mutation paths.

### Task 4: Verification and progress record

- [ ] Run focused Vitest tests, contracts/AI/worker typechecks, targeted ESLint, and `git diff --check`.
- [ ] Run `graphify update .` once after the coherent Task 14 slice.
- [ ] Run the repository unit suite and build if the environment permits; report any Bash/service blockers separately.
- [ ] Update `README.md` with a concise Task 14 status line only after verification evidence exists, keeping Task 15 as the next planned feature.
- [ ] Add a dated Task 14 execution-status note to the current phase plan without rewriting historical requirements.
- [ ] Conduct the coordinator's final review for role coverage, schema validation, provenance completeness, candidate-only invariants, and unrelated file changes.

## Acceptance Checklist

- [ ] All eight roles have explicit policy and tests.
- [ ] Provider output is schema-validated before job results are returned.
- [ ] Job results include complete provider/model/policy/source/cost/request provenance.
- [ ] Silent role performs no provider call and returns a valid candidate-only result.
- [ ] No code path in this slice can mutate confirmed assets.
- [ ] Focused tests and typechecks pass; unavailable external gates are explicitly recorded.

## Execution Record

- [x] The coordinator attempted the requested `5.6-luna` model; the collaboration runtime rejected it, so `gpt-5.6-terra` implemented this slice. The coordinator's independent review found and repaired candidate-proposal and source-retrieval policy bypasses plus provenance fabrication.
- [x] Focused verification passed: `npx vitest run packages/ai/src/roles.test.ts packages/ai/src/providers/provider.test.ts tests/integration/exploration-chat-job.test.ts` reported 3 files and 10 tests passing.
- [x] `npx tsc -p packages/contracts/tsconfig.json --noEmit`, `npx tsc -p packages/ai/tsconfig.json --noEmit`, `npx tsc -p apps/worker/tsconfig.json --noEmit`, targeted ESLint, `git diff --check`, and `graphify update .` passed.
- [ ] The full `npm test` suite is blocked rather than passed: PowerShell has no `bash`; Git Bash starts the runner but lacks `flock`. Run the repository gates from WSL or another Bash environment that provides `flock`.
