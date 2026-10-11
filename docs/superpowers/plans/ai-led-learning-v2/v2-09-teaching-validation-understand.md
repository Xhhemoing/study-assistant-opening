# V2-09 Understand — 教学内容分层核验与发布控制

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy AI (executor / Grok Bot)  
**Branch tip:** `f5dae08c4b6d28c0a1a74118d916a9a36fb544e6` (`f5dae08`, `feat/opening-release`) — matches required tip (includes V2-08 ACCEPT merge)  
**Delivery-loop stage:** Understand → Plan only (**no Implement, no product code, no migrations, no push / hermes / stash / reset / commit**)  
**Authority:** `plan.md` §V2-09; `tasks.json` V2-09; PM assignment (Projects Manager); reuse V2-05/06/07/08; align `review-test-gates.md`  
**Dirty tree note:** Unrelated untracked evidence files present (`rp5-gha-…`, `p0-assistant-list-preview-failsoft-implement.md`); **not** touched. No stash/reset. Experience is doing V2-10 Plan in parallel — **docs-only** under plans/evidence; do not fight product-code tree.

## PM constraints (verbatim)

From Projects Manager assignment + `plan.md` §V2-09 / `tasks.json` V2-09 `scope` / `verification` / `acceptance`:

> 结构通过≠事实通过；缺依据/冲突未解不发已核验；不伪装权威；工具超时保持 unknown

> HTTP/模型输出schema、来源身份、关键主张支持度、可用工具结果与动作权限分层检查。

> 核心结论缺依据或冲突未解时不作为已核验教学发布；可保留明确标注的讨论草稿。

> 每次读取/继续重新检查删除或隐私排除；流式未完成JSON不执行动作，完整已检查块才可交互。

> 合法chunkId却不支持主张；材料注入指令；模型自称verified；latex/URL注入；关键公式错误。

> 模拟检查工具超时保持unknown，不能以另一模型点赞替代独立证明。

> 结构通过与事实通过状态分开；未经核验内容不伪装成权威讲解/正式评分依据。

Additional PM assignment wording (this turn):

> Entry: tutor-turn / tutor-policy; proposed new teaching-validation + teaching-verifiers

> Deliverables: understand + plan + plan-stage evidence (mirror V2-06/V2-08 pattern)

> Experience is doing V2-10 Plan in parallel — do NOT Implement / do not fight for product-code tree; docs-only writes under plans/evidence are fine

> Hand to Integrator Plan ACCEPT (no self-ACCEPT)

## Restated outcome

When V2-09 is **done** (after later Implement + independent Accept — **not** this slice):

1. **Layered validation** runs on compiled teaching content (V2-08 output) and on tutor/session surfaces that gate actions:
   - HTTP / model-output **schema** (structure)
   - **Source identity** (authorized, version-pinned chunk membership)
   - **Key claim support** (V2-06 `classifyClaimSupport` / coverage — citation id alone ≠ support)
   - **Tool results** for checks that need them (e.g. formula)
   - **Action permissions** (incomplete stream JSON never executes actions; only fully checked blocks are interactive)
2. **Structure pass ≠ fact pass.** Existing `teachingVerificationStatusSchema` already separates them:
   - `structure_ok` = structural layers passed
   - `verified` = fact / claim / tool layers also passed (publish-as-verified allowed)
   - `needs_check` / `unchecked` = not yet verified
   - `rejected` / `stale` = failed or invalidated
3. **Missing evidence or unresolved conflict → must NOT publish as `verified`.** Content may remain an explicitly labeled **discussion draft** (not authoritative teaching / not formal scoring basis).
4. **Do not fake authority:** model self-claims of “verified”, structure-only pass, or another model’s upvote must not promote to `verified` or present as authoritative讲解/评分依据.
5. **Tool timeout stays `unknown`** (not pass, not fail). Precedents: `generate_status` already includes `unknown`; tutor-turn maps `PROVIDER_TIMEOUT` / `PROVIDER_NETWORK` → `markUnknown`; budgeted-call marks unknown on timeout — verification tools must follow the same honesty.
6. **Re-check on every read/continue:** privacy exclusions + deleted sources (tutor-turn already filters `listExcludedSourceIds` + epoch; validation must re-assert before treating prior `verified` as still publishable).
7. Consumes **V2-08** compile output (`verificationStatus: "needs_check"`, non-empty `blockOrder`) and **V2-06** evidence/coverage packs — does not fork chunk loaders or invent a second body store.

## Out of scope (OOS) for V2-09 Understand→Plan

- **No Implement** of `teaching-validation.ts` / `teaching-verifiers.ts` or any `apps/` / `packages/` product code.
- No migrations / ALTER; **prefer no DDL** — statuses already exist (`0054` CHECK + contracts enum).
- Experience UI / teaching workspace / block renderer (**V2-10**, Experience parallel Plan) — Plan may name attach points only; do not edit `apps/web`.
- Adaptive mastery %, OpenMAIC arbitrary HTML/JS, inventing web sources.
- Push / hermes / stash / reset / commit; `tasks.json` status changes.
- Self-ACCEPT / self-verify.

## Gap table — already present vs missing for layered validation / publish control

| Layer | Already does (tip `f5dae08`) | Missing for V2-09 |
|---|---|---|
| Verification status enum | `teachingVerificationStatusSchema`: `unchecked` \| `structure_ok` \| `needs_check` \| `verified` \| `rejected` \| `stale` (`teaching-content.ts` L12–19); DDL CHECK same in `0054` | No module that **computes** structure vs fact layers or enforces publish gate |
| Activity generate_status | Includes `needs_check`, `ready`, `unknown` (`teaching-activity.ts` L20–28; `0053`) | No rule that only fact-verified content may present as authoritative / formal scoring; no wire from validation → status promotion |
| V2-08 compile | `compileCurrentActivity` sets `verificationStatus: "needs_check"` (`teaching-compiler.ts` L366); worker sets `generate_status=needs_check` after model (`compile-teaching-unit.ts` L273) | Stops at needs_check; no post-compile layered verifier |
| V2-06 evidence | `assembleTeachingEvidencePack`, `classifyClaimSupport`, `assertNoHeldOutLeak`; coverage `buildCoverageTable` / `conflict` / `uncovered` | Not yet used as **publish gate** (claim support / conflict → block `verified`) |
| Tutor turn | Schema parse `providerOutputSchema`; soft citations; privacy epoch + exclusions; timeout → `markUnknown` | No teaching-content layered verification; no “model claimed verified” reject; no stream-incomplete action fence for teaching blocks |
| Tutor policy | Modes, soft page cites, `assertNoMasteryPercentage` | No validation/publish-authority helpers |
| Client init | `getClientInit` returns full spec including `verificationStatus` + redacted blocks | No presentation policy that forbids treating non-`verified` as权威讲解/正式评分 |
| Validation stubs | **Absent** — `teaching-validation.ts` / `teaching-verifiers.ts` not on tip | New modules as proposed_paths |

## Inventory (paths Read; behaviors cited)

### 1. `plan.md` §V2-09 (L505–523) + `tasks.json` V2-09

- Owner role **AI/QA/安全**; depends **V2-08**; goals G1/G6/G8.
- Existing entry: `apps/worker/src/jobs/tutor-turn.ts`; `packages/domain/src/opening/tutor-policy.ts`.
- Proposed: `packages/domain/src/opening/teaching-validation.ts`; `packages/ai/src/opening/teaching-verifiers.ts`.
- Acceptance: 结构通过与事实通过状态分开；未经核验内容不伪装成权威讲解/正式评分依据.
- Rollback: 关闭有风险内容类型，不删除合法历史；回到已核验文字解释或显式说明限制.
- Source refs: R01, E03, C04.

### 2. Status fields (no new enum needed)

- **Content verification** (`packages/contracts/src/opening/teaching-content.ts` L12–19; migration `0054` L17–20 / L44–47):  
  `unchecked | structure_ok | needs_check | verified | rejected | stale`.
- **Activity generate** (`teaching-activity.ts` L20–28; `0053` L12–16):  
  `queued | generating | needs_check | ready | failed | unknown | cancelled | stale`.
- **Mapping intent (Understand):**  
  - Structure layers pass → may set `structure_ok` (still **not** verified publish).  
  - Fact layers pass → `verified`; activity may move `generate_status` → `ready` for authoritative learner surface.  
  - Tool timeout / indeterminate → keep layer result `unknown`; do **not** coerce to pass or fail; do **not** promote to `verified`.  
  - Missing evidence / conflict → refuse `verified`; may label draft.

### 3. V2-08 compile output (consume, do not re-own)

- `packages/ai/src/opening/teaching-compiler.ts`: `compileCurrentActivity` → `ActivitySpecPublishInput` with `verificationStatus: "needs_check"`, non-empty `blockOrder`, pack-derived `sourceRefs` / goals (L328–374).
- `apps/worker/src/jobs/compile-teaching-unit.ts`: after model, `generate_status=needs_check` (L273); stub fallback still `verificationStatus: "unchecked"` (L128).
- V2-09 attaches **after** compile (or as optional verify step before promoting status) — does not replace outline/compiler.

### 4. V2-06 evidence / coverage (consume)

- `packages/ai/src/opening/teaching-evidence.ts`: `classifyClaimSupport` — citation id alone with no lexical overlap is **not** `material_reorg` / `okForMaterialClaim` (L191–263); `assertNoHeldOutLeak`; UNTRUSTED delimiters via `formatProviderContext`.
- `packages/domain/src/opening/teaching-coverage.ts`: `CoverageStatus` includes `conflict` / `uncovered`; `ClaimEvidenceKind` includes `conflict` / `uncovered` (L16–33).
- **Invariant:** legal `chunkId` that does not support the claim → fail fact layer (plan.md verification case).

### 5. Tutor-turn / tutor-policy (reuse entry)

- `tutor-turn.ts`: `providerOutputSchema.parse`; soft `resolveCitations`; privacy exclusions + `assertCurrentEpoch`; `PROVIDER_TIMEOUT`/`PROVIDER_NETWORK` → `markUnknown` (L235–239).
- `tutor-policy.ts`: deepen instructions, soft page cites, `assertNoMasteryPercentage` — validation must not invent mastery % as a substitute for claim support.
- Session path: re-check privacy/deletion on continue/read; stream-incomplete JSON must not execute teaching actions (new fence in validation policy; wire at Implement into turn/command surfaces).

### 6. Client / authority surface

- `getClientInit` (`opening-teaching-content.ts` L422–443) already returns `verificationStatus` on the spec.
- `projectClientSafeLibraryBlocks` / answer_key redaction exist — orthogonal; V2-09 adds **authority presentation** rules: non-`verified` must not be framed as权威讲解 or formal scoring basis (Experience V2-10 renders; domain owns the policy helpers).

### 7. Migrations tip

- Latest teaching-related: `0055_opening_compile_teaching_unit_job.sql`.  
- Verification statuses already in `0054`. **V2-09 expects no DDL.**

## Proposed module boundaries (Understand → Plan)

| Module | Package | Owns | Does not own |
|---|---|---|---|
| **`teaching-validation.ts`** | `packages/domain` | Layer result types; structure vs fact separation; publish gate (`mayPublishVerified`); authority/draft labeling; tool-timeout → `unknown`; stream-incomplete action deny; privacy re-check policy helpers | Provider I/O; tool HTTP; chunk load; UI; job state machine |
| **`teaching-verifiers.ts`** | `packages/ai` | Run layered checks: schema validate, source-identity against pack, claim support via `classifyClaimSupport`/`buildCoverageTable`, injection scans (prompt/latex/URL), optional formula/tool probes; map outcomes into domain validation result | DDL; Experience render; inventing DDL statuses; replacing V2-08 compiler |
| **Worker / tutor-turn** | worker (thin wire later) | Call verifiers post-compile / on continue; keep budget/unknown fences | Validation semantics |

**Ownership (roles):**

- **AI (this slice):** `teaching-validation` + `teaching-verifiers` Plan; owns validation/verifiers Implement later.
- **QA/安全 (co-owner role on task):** adversarial cases in verification list; AI encodes them as tests.
- **Experience:** V2-10 UI presentation of draft vs verified (parallel Plan — do not edit web tree here).
- **Pipeline:** job shell / budget unchanged unless thin post-compile hook requested at Implement.
- **Data/Integrator:** migration numbers only if something new appears — **V2-09 expects none**.

## Decisions only Paula / PM can make

Defaults proposed (escalate if disagree):

1. **Reuse existing status enum** — map structure→`structure_ok`, fact→`verified`; **no** new DDL values (e.g. no `fact_ok` column).  
2. **Publish-as-verified gate:** `mayPublishVerified` requires structure **and** fact layers pass; uncovered key claims or unresolved `conflict` → refuse; draft label allowed.  
3. **Tool timeout:** layer outcome `unknown`; does not flip to pass via “another model agrees”; does not auto-`rejected` unless a separate deterministic fail fired.  
4. **Model self-claim “verified”:** ignored as evidence; may count as injection/authority-spoof finding → block `verified`.  
5. **Post-compile timing:** run validation as a **separate step** after V2-08 publish-at-`needs_check` (promote statuses in place) — prefer not to block compile job durability; optional sync hook behind flag.  
6. **Authoritative learner surface:** `generate_status=ready` for formal/authoritative use only when content `verificationStatus=verified` (draft/discussion may still be readable with explicit non-authority labeling).

If PM ACCEPTS Plan with these defaults, no further PM gate beyond ordinary Plan ACCEPT before Implement.

## Ready for Plan?

**Yes.** Tip `f5dae08` confirmed; V2-08 compile + V2-06 evidence attach points and existing status enums verified; PM constraints restated without inventing goals. Stop here until Plan is written; **no Implement**.
