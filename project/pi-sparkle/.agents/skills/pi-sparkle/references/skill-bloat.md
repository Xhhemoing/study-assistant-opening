# Skill Bloat & Performance

## Detection Signals
- `~/.agents/skills/` > 20 SKILL.md files
- No `usageCount` or `lastActivated` in any skill frontmatter
- scenario-skill-router always reads full table even for trivial tasks

## Observed Failures
- Subagent "Unknown agent: tokenfree-luna" (project agent drifted, global list stale)
- No prune command; skills accumulate across experiments

## Proposed Fix
1. Add `usage` frontmatter to every skill (count, lastUsed, projects)
2. New command: `pi skill prune --dry-run` (lists unused >90 days)
3. Router logs activation to `.pi/logs/skill-routes.jsonl` (one line per task)

## Validation
- After 10 sessions, `pi skill audit` reports top-5 activated + bottom-5 never-used
