# V2-13 migration number assigned

- **Tip at assign:** `e85a73bff8df93de254e68c5286721860c6723e1` (`e85a73b`, `feat/opening-release`)
- **Data Plan tip:** `9a508a7` (ancestor; Accept tip includes later V2-12 `node:crypto` fix only)
- **Repo files:** highest present = `0056_opening_intervention_settings.sql` under `packages/database/src/migrations/`
- **Assigned for V2-13:** **0057** (next free; no `0057_*` file on tip at assignment)
- **Implement filename:** `packages/database/src/migrations/0057_opening_help_exposure_kind.sql` (replaces Plan placeholder `00xx_opening_help_exposure_kind.sql`)
- **DDL purpose:** extend `opening_help_exposures`:
  - `kind TEXT NOT NULL` with CHECK (`instruction` | `hint` | `solution`); backfill existing rows `'hint'`
  - nullable `activity_id`
  - nullable `item_version_id` (Integrator includes at assign; prefer column over join-only)
- **Live `schema_migrations`:** not queried this note (box may lack hermes DB); if live max ≥ 0057, Integrator must renumber before apply
- **No ALTER executed** by this assignment; **SQL file not created** at Plan ACCEPT / assign
- **Authority:** Plan ACCEPT `v2-13-teaching-answer-evidence-plan-accept.md` (2026-10-11) + PM frozen defaults
