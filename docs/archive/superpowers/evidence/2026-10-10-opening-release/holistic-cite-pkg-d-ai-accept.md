# cite Package D — AI/server half ACCEPT

**Owner:** Integrator (ACCEPT)  
**Date:** 2026-10-10 ~23:34 CST (Asia/Shanghai)  
**Branch tip baseline:** `feat/opening-release` @ `cf5d046` (Package C)  
**Implement evidence:** `holistic-cite-pkg-d-ai-implement.md`  
**Plan:** `docs/superpowers/plans/opening-release/holistic-chat-cite-audit-p0-plan.md` § Package D (AI/contracts/domain/worker)  
**Verdict:** **ACCEPT**  
**Push / commit:** none (accept-only; working tree remains dirty)

## Scope reviewed (AI half only)

| Expectation | Result |
|---|---|
| `citationSchema` optional `page` / `startMs` / `slideLabel` | Present in `packages/contracts/src/opening/sources.ts`; contracts + resume tests cover omit + with-locators |
| `resolveCitations` fills locators + soft unknown ids | Default `soft: true`; populates `page`/`startMs`/`slideLabel`; `sourceNames` humanize; strict `{ soft: false }` still throws |
| Page guard softened | `assertCitationsForPage` no-op soft; `preferCitationsForPage` exported; tutor-turn empty cites + `currentPage` completes as general |
| Tutor-turn soft-filter | Unknown ids dropped; on-page preferred when any match; locators on completed citations |
| Image-only auth keeps vision gate | `tutor-service` `authorizedChunksFor` allows empty text + `imageObjectKey`; ephemeral filters same + throws `VISION_REQUIRED` when no vision (worker tests already cover reject / page-1 attach) |
| Prompt tighten | `makeTutorInstruction` cite suffix; provider `outputInstruction` prefers non-empty `citedChunkIds` when materials used |
| Experience UI **not** in this half | AI implementer did not edit `assistant-view*` / `message-list*` / `source-viewer*` / `upload-strip*` |

## Diff vs `cf5d046` (AI/contracts/domain/worker/tutor)

14 files, +269 / −59 (AI half paths only):

- `packages/contracts/src/opening/sources.ts` (+ contracts / resume tests)
- `packages/ai/src/opening/citations.ts` (+test), `provider.ts`
- `packages/domain/src/opening/tutor-policy.ts` (+test), `index.ts`
- `apps/worker/src/jobs/tutor-turn.ts` (+test)
- `apps/web/.../tutor/tutor-service.ts` (+test), `ephemeral-service.ts`

**Out of slice (parallel Experience WIP on same tree):** `assistant-view.tsx`, `message-list*`, `inbox/source-viewer*`, library/inbox pages, plus `holistic-cite-pkg-d-experience-implement.md` / experience-accept. Not judged here. Shared notify contract (`citationSchema` locators) is the agreed handoff.

## Stronger review (must fail if locators / soft-filter omitted)

- `citations.test.ts`: soft-filters unknown by default; asserts `page` / `startMs` / `slideLabel` on resolved rows; strict mode still throws — omitting populate or soft default fails these.
- `tutor-turn.test.ts`: empty cites + page completes (no `PageCitationError`); soft-filters invented id and prefers on-page cite with `page: 1`.
- `tutor-policy.test.ts`: soft assert never throws; `preferCitationsForPage` filters / keeps off-page when no match.
- `contracts.test.ts` / `conversation-resume.test.ts`: schema + resume history carry optional locators.
- `tutor-service.test.ts`: image-only material (empty text + `imageObjectKey`) accepted for cite path.

No product edits made during accept.

## Gates re-run (this accept)

### Vitest (exact files + counts)

```bash
./node_modules/.bin/vitest run \
  packages/ai/src/opening/citations.test.ts \
  packages/domain/src/opening/tutor-policy.test.ts \
  packages/contracts/src/opening/contracts.test.ts \
  packages/contracts/src/opening/conversation-resume.test.ts \
  apps/worker/src/jobs/tutor-turn.test.ts \
  apps/web/src/features/opening/tutor/tutor-service.test.ts \
  apps/web/src/features/opening/tutor/ephemeral-service.test.ts \
  packages/ai/src/opening/provider.test.ts
```

**Result:** Test Files **8 passed** (8); Tests **142 passed** (142); Duration ~6.1s (~23:33 CST).

Matches implementer claim of 8/142. (No separate 4-file / 78 re-run performed; full 8-file set above is the accept gate.)

### Typecheck

| Package | Command | Result |
|---|---|---|
| `packages/contracts` | `npm run typecheck` | pass |
| `packages/ai` | `npm run typecheck` | pass |
| `packages/domain` | `npm run typecheck` | pass |
| `apps/worker` | `npm run typecheck` | pass |
| `apps/web` | `npm run typecheck` | pass (tutor half consumers) |

## Experience half

**Out of this accept.** Chip → in-app viewer / `sourceViewerHref` / message-list deep-links belong to Experience Package D (`holistic-cite-pkg-d-experience-*`). Do not block AI ACCEPT on Experience UI dirty tree.

## Blockers

None for AI/server half.

## Non-actions

No commit / push / stash / reset. No product code edits by Integrator.
