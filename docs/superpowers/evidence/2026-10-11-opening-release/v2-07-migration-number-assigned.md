# V2-07 migration number assigned

- **Tip:** `cccc39272fd3a7d565a946b3979d0231220cbee2` (`feat/opening-release`)
- **Repo files:** highest present = `0054_opening_teaching_content.sql` under `packages/database/src/migrations/`
- **Assigned for V2-07:** **0055** (next free; no `0055_*` file on tip at assignment)
- **Implement filename:** `packages/database/src/migrations/0055_opening_compile_teaching_unit_job.sql` (replaces Plan placeholder `00xx_opening_compile_teaching_unit_job.sql`)
- **DDL purpose:** extend `opening_jobs_kind_check` to include `'compile-teaching-unit'` (pattern of `0050` / `0051`); no new tables for M1
- **Live `schema_migrations`:** not queried this note (box may lack hermes DB); if live max ≥ 0055, Integrator must renumber before apply
- **No ALTER executed** by this assignment
- **Authority:** Plan ACCEPT `v2-07-teaching-generation-jobs-plan-accept.md` (2026-10-11)
