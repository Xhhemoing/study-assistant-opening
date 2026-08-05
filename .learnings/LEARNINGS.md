# Learnings

Corrections, insights, and knowledge gaps captured during development.

**Categories**: correction | insight | knowledge_gap | best_practice

---

## [LRN-20260804-002] correction

**Logged**: 2026-08-04T23:17:00+08:00
**Priority**: high
**Status**: pending
**Area**: config

### Summary
Luna delegation is available through OpenCodex injection, not the native subagent model parameter.

### Details
The native subagent model validator accepts only Sol/Terra labels, while OpenCodex injects the enabled `gpt-5.6-luna` runtime behind the compatible OCX agent type. Treating the native validation result as Luna unavailability caused an incorrect user-facing response.

### Suggested Action
Before rejecting a requested model, check `opencodex models live` and delegate through the matching OCX route when it reports the requested runtime as enabled.

### Metadata
- Source: user_feedback
- Related Files: docs/superpowers/plans/2026-08-04-task-15-selective-promotion-implementation.md
- Tags: subagent, opencodex, luna, model-routing

---

## [LRN-20260803-001] best_practice

**Logged**: 2026-08-03T00:00:00+08:00
**Priority**: medium
**Status**: pending
**Area**: docs

### Summary
PowerShell documentation checks must specify UTF-8 when matching Chinese content.

### Details
`Get-Content` without an explicit encoding decoded a UTF-8 Chinese brainstorm document incorrectly and produced a false report that required headings were missing. Re-running the same check with `Get-Content -Encoding UTF8` and `Select-String -Encoding UTF8` found every required section.

### Suggested Action
Use explicit `-Encoding UTF8` for PowerShell reads and searches that validate repository documents containing non-ASCII text.

### Metadata
- Source: error
- Related Files: docs/brainstorm/2026-08-03-self-directed-student-artifact-autopilot.md
- Tags: powershell, utf8, documentation, validation
- Pattern-Key: tooling.powershell_utf8_document_validation
- Recurrence-Count: 1
- First-Seen: 2026-08-03
- Last-Seen: 2026-08-03

---

## [LRN-20260804-001] correction

**Logged**: 2026-08-04T17:10:00+08:00
**Priority**: high
**Status**: pending
**Area**: frontend

### Summary
Do not treat an HTTP 200 shell response as a usable app when the client-side entry redirect is still loading.

### Details
The root page renders a loading shell and waits for `/api/workspace/preferences` before routing. Missing environment configuration caused that API to throw before its error boundary, leaving the browser on "正在进入 AIstudy" indefinitely. User feedback correctly identified that the app was not actually usable.

### Suggested Action
Verify the browser-visible state after client-side redirects, inspect dependent API responses, and treat an unresolved loading state as a blocking defect.

### Metadata
- Source: user_feedback
- Related Files: apps/web/src/features/workspace/root-redirect.tsx, apps/web/src/app/api/workspace/preferences/route.ts
- Tags: nextjs, client-redirect, loading-state, verification

---
