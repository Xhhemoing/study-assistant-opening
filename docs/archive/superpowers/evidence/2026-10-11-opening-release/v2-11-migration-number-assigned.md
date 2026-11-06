# V2-11 migration number assigned

- **Tip:** `0436946ed1dd58aa414313bb1283e9f2e7f162c3` (`feat/opening-release`)
- **Repo files:** highest present = `0055_opening_compile_teaching_unit_job.sql` under `packages/database/src/migrations/`
- **Assigned for V2-11:** **0056** (next free; no `0056_*` file on tip at assignment)
- **Implement filename:** `packages/database/src/migrations/0056_opening_intervention_settings.sql` (replaces Plan placeholder `00xx_opening_intervention_settings.sql`)
- **DDL purpose:** additive `intervention_settings jsonb` on `workspace_preferences` and `courses` (no decisions table in M1)
- **Live `schema_migrations`:** not queried this note (box may lack hermes DB); if live max ≥ 0056, Integrator must renumber before apply
- **No ALTER executed** by this assignment; **SQL file not created** at Plan ACCEPT
- **Authority:** Plan ACCEPT `v2-11-intervention-prefs-plan-accept.md` (2026-10-11)
