# Materials + course link P0 Plan — Integrator review

**Date:** 2026-10-10 ~22:16 CST  
**Reviewer:** INTEGRATOR  
**Source:** `materials-course-link-p0-plan.md`  
**Verdict:** **AGREE**

## Why AGREE

- Restores discoverability of materials without undoing R2 (more + palette, not core nav).
- Course「添加材料」and row「归入课程」reuse `addToCourse` / memberships — no new API.
- Parses left out of scope correctly.

## Implement notes (non-blocking)

1. Prefer `href: "/opening/library?tab=materials"`; keep `navigationIsActive` working for `/opening/library`.
2. Course panel: default role `reference`; prefer uploaded sources; show succeeded/failed like batch.
3. Row shortcut opens course picker; keep batch bar.
4. Don’t reintroduce explore/marketplace/learn.

## Next

Experience IMPLEMENT → Integrator Accept → PM push/hermes.
