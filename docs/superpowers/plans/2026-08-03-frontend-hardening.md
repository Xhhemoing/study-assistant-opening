# Frontend Hardening Plan

## Slice 1: Identity, storage, and goal-plan correctness

Files:

- `apps/web/src/lib/data/react.ts`
- `apps/web/src/lib/data/react.test.ts`
- `apps/web/src/lib/data/mock/storage.ts`
- `apps/web/src/lib/data/mock/storage.test.ts`
- `apps/web/src/lib/data/mock/provider-state.ts`
- `apps/web/src/lib/data/mock/provider-plan.ts`
- `apps/web/src/lib/data/mock/provider.test.ts`
- `apps/web/src/features/goals/goal-detail.tsx`
- `apps/web/src/features/goals/goal-components.test.ts`

Steps:

1. Add tests for repeated auth requests, failed reload clearing, malformed storage cleanup, valid empty goals, and stale plan overlays.
2. Run the focused tests and record RED failures.
3. Implement identity/cache, storage, seed, and plan fixes without changing the provider interface.
4. Run the focused tests and typecheck; update Graphify once for the completed slice.

## Slice 2: Complete the learning workflow

Focus on `today-plan-model.tsx`, `today-plan-view.tsx`, `learn/page.tsx`, `library-document-list.tsx`, `settings-view.tsx`, the `/settings` route, and `provider-explore.ts`. The slice connects `/learn` to the mock TodayPlan, makes library rows open their editor route, adds a working settings surface, and makes candidate terminal status updates idempotent.

Each behavior gets its closest model/provider test before implementation.

## Slice 3: Async recovery and accessibility

Focus on tag search normalization, retryable load states, candidate action idempotency, command palette and drawer focus management, and contract validation. Add focused component/model tests and one browser-level smoke check where the local environment supports it.

## Completion Gates

- No unrelated files are changed.
- New and changed UI uses existing Tailwind utilities and `lucide-react` icons.
- `graphify update .` runs once after each complete slice, not after individual edits.
- Fresh verification output is reported; unavailable PostgreSQL, Redis, environment variables, or Chromium are called out explicitly.
