# Frontend Hardening Design

## Scope

This slice hardens the existing workspace UI and mock-backed learning flow without changing the provider boundary. The mock provider remains the local development implementation; real API provider migration is out of scope.

The work is organized around three user-visible risks found during the 24-hour review:

1. Session identity and browser data can outlive the authenticated user.
2. The learn workflow contains incomplete or stale entry points.
3. Async UI and overlay controls can fail without recovery or accessible focus behavior.

## Design Decisions

### Identity and storage

- Fetch `/api/auth/me` for each hook lifecycle instead of retaining a module-global Promise.
- Clear stale async data before a reload and when a load fails.
- Keep every mock domain namespaced by `userId`.
- Treat malformed JSON as recoverable data loss: remove the broken domain entry before returning its fallback.
- Seed only when the goals domain is absent, not when a valid empty goal collection exists.

### Goals and plans

- Goal detail reloads must ignore results from an older goal id or an unmounted request.
- Today-plan snapshots are keyed by date and preserve overlays only for task ids that still exist in the regenerated plan.
- The active goal is selected explicitly from the current non-archived goals list; no archived goal can generate a plan.

### UI reliability

- Every failed data surface exposes a retry action that reuses the existing Tailwind-only visual language.
- Search, drawers, and command menus retain semantic roles, keyboard navigation, and focus return behavior.
- Existing copy, routes, business operations, and `/prototype` remain unchanged unless a dead link or broken state is directly in scope.

## Verification

Each implementation slice starts with a regression test and a failing test run, then gets the smallest implementation that turns the test green. After a coherent slice, run one `graphify update .` and the focused Vitest suite. Final handoff requires fresh lint, typecheck, relevant Vitest suites, and a clear report for environment-gated integration/browser checks.
