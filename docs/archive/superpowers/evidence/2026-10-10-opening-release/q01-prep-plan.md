# Q01-prep — Plan: inventory → red skeleton → later IMPLEMENT (READY_FOR_PM_REVIEW)

**Date:** 2026-10-10 ~01:04 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Owner:** QA  
**Depends (ledger):** U03, Q03, DL3, DL6, DL7, DL10 — see Understand; Q03 still **active**  
**Sources:** `08-delivery.md` §Q01; `q01-prep-understand.md`; `q01-prep-coverage.md`  
**Gate:** **READY_FOR_PM_REVIEW** — prep docs only; do **not** IMPLEMENT Create-list tests or flip Q01 status until PM / stronger review says go **and** Q03 completion allows backup-bound verification

## Outcome (after full Q01 IMPLEMENT — not this pass)

Create-list + Modify tests prove cross-module negatives, concurrency, fault recovery, and (against **completed** Q03) backup privacy. Gates green on isolated services. Q01 may then move toward verified **only** with observed evidence — never from this prep alone.

## Prep-only outcome (this pass)

| Deliverable | Path | Role |
|---|---|---|
| Understand | `q01-prep-understand.md` | Restate §Q01 + dependsOn + blockers |
| Plan | `q01-prep-plan.md` (this file) | Sequencing + gates |
| Coverage inventory | `q01-prep-coverage.md` | Exists vs missing vs related gaps |
| Red skeleton (docs) | `q01-prep-red-skeleton.md` | Proposed first failing cases — **no claim of green** |

**Explicit non-goals this pass:** no `tasks.json` edit; no Q01 active/verified; no product/hermes/redeploy edits; no Docker claims; no commit/push; prefer **docs-only** (no new test files that could break CI).

## Sequencing

```
[1] PREP (now)     inventory + understand + plan + skeleton docs
        ↓ READY_FOR_PM_REVIEW on prep docs
[2] RED SKELETON   (later, after PM go) — Create-list files as skipped/WIP
                   OR gated path; must not break existing CI
        ↓ Q03 still may be active — backup Modify deferred/partial
[3] IMPLEMENT      fill red→green when PM authorizes AND Q03 allows
                   backup-bound verification (Q03 completed/verified)
        ↓ observed evidence
[4] VERIFY         unit/contract/handler/integration gates; then ledger
```

### Phase 1 — Prep (this pass) ✅ docs

1. Confirm dependsOn snapshot without mutating ledger.
2. Inventory Create-list + related opening auth/concurrency/backup/failure tests.
3. Document blockers: Q03 active; Docker packaging unclaimed; Create-list 4/5 missing.
4. Stop at **READY_FOR_PM_REVIEW** for prep docs.

### Phase 2 — Red skeleton (later IMPLEMENT authorization)

Preferred order (safest first):

1. **Docs-only examples** (already in `q01-prep-red-skeleton.md`) — no CI impact.
2. If PM asks for files: add Create-list paths with `it.skip` / `describe.skip` or under an explicitly gated project/path that existing CI does not run — label WIP clearly.
3. Do **not** land failing unskipped tests into default CI.

First failing cases to encode (from §Q01 example + coverage gaps):

- Anonymous memory → 401 (`requestAnonymous('/api/opening/memory')`).
- Two-principal: sources / conversations / memory / learning / plans isolation.
- Stale plan accept / concurrent accept coordination.
- At least one fault: MIME spoof, unconfigured provider, or budget exhaustion (wire to DL7 readiness/cap).
- Backup privacy Modify only when Q03 completion criteria are met (or keep skip + note).

### Phase 3 — IMPLEMENT (blocked)

- Fill Create-list files; extend Modify backup privacy as needed.
- Complete saved flow assertions (DB rows + versions).
- Fault matrix + regression IDs.
- Run isolated gates (DL10 path).
- **Do not** mark Q01 verified while Q03 is active or Docker/packaging claims are false.

## Acceptance checks (prep docs)

- [x] Understand restates §Q01 Create/Modify/Depends and blockers.
- [x] Plan uses READY_FOR_PM_REVIEW and forbids ledger flip this pass.
- [x] Coverage table: Create-list exists vs missing + related partials + gaps.
- [x] Red skeleton documents proposed failing cases with **no green claim**.
- [ ] PM / stronger review accepts prep → authorizes Phase 2/3 separately.
- [ ] Q01 remains `planned` in `tasks.json` until an authorized later pass.

## Rejected alternatives

- **Mark Q01 active now** — PM authorized prep-only; ledger stays planned.
- **Commit failing Create-list tests into default CI** — rejects; prefer docs or `.skip`/gated path.
- **Claim Q01 unblocked because backup-privacy.test.ts exists** — file exists under Q03 work, but Q03 is not completed; backup gate for Q01 verified still blocked.
- **Docker / packaging green as part of Q01 prep** — out of scope; Q03 owns; no Docker claims here.
- **Touch hermes / apps product / 15-research-hardening / Q03 ledger** — forbidden this pass.

## READY_FOR_PM_REVIEW

Prep documentation set is ready for PM review. **No IMPLEMENT.** **No ledger change.** Integrator may commit these evidence files when appropriate; this agent does not commit/push.
