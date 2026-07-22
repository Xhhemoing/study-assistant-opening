# Auth spike

**Goal:** Prove signed session tokens identify a user and object-level authorization denies cross-user access.

Uses `jose` (JWT/JWS) as a minimal session primitive candidate; production auth library is finalized in ADR-001 after this spike.

**Test:** `src/session-authz.test.ts`
