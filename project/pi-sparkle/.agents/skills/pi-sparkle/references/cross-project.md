# Cross-Project Knowledge Isolation

## Observed State
- AIstudy: aistudy-git-workflow, impeccable, 4 agents, 5 prompts, 7 nested AGENTS.md
- cengfan: cengfan-data-import, temp-luna/tokenfree-luna agents, subagent runs with project-specific models
- better-harness (QoderAI): harness-skill-creator, change-traceability-review, skill-review, triangulate-spec-review + detailed AGENTS.md
- Pi core: skills only at ~/.agents/skills/, no self-review harness, no .pi/

No mechanism to promote reusable assets (e.g., aistudy-git-workflow) to global or share cengfan-data-import.

## Risks
- Duplicate effort (every project reinvents git workflow, verification discipline)
- Agent drift (tokenfree-luna exists in cengfan but not discoverable elsewhere)
- Lost improvements (better-harness meta-skills not fed back to pi core)

## Proposed Fix
1. `~/.agents/skills/shared/` directory for cross-project skills (symlink or copy-on-use)
2. `pi skill promote <name> --to shared` command
3. `pi skill sync` pulls shared skills into current project .agents/skills/ with conflict marker
4. Global registry file `~/.pi/skill-registry.json` tracks origin project + usage count

## Validation
- After 3 projects adopt, `pi skill audit --global` shows at least 2 shared skills with >5 activations each
