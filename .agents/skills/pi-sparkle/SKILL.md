---
name: pi-sparkle
description: Use when auditing pi agent operations, detecting skill bloat/performance degradation, analyzing evidence boundary gaps, cross-project knowledge isolation, missing meta-skills, verification discipline execution gaps, reliable-delivery bottlenecks, skill routing observability, negative case capture, agent config drift, and prompt optimization (avoid over/under-fitting via scenario similarity). Trigger for pi self-review, harness health checks, or when user reports pi feels slow or skills are proliferating.
---

# Pi Sparkle

Pi agent self-diagnosis, optimization, and harness evolution skill.

Load at most the references needed for the current dimension. Keep analysis evidence-based; do not invent usage data.

## Core Findings Recorded (from local multi-project survey)

### 1. Skill Proliferation & Performance
- 21 skills in ~/.agents/skills (scenario-skill-router caps at 2 per task)
- No prune/usage-audit mechanism; no bloat detection
- Subagent runs in .pi/subagents/runs/ show agent-not-found failures when project agents drift

### 2. Evidence Boundary Problem
- Better-harness reports: 80%+ dimensions "not observed in this boundary"
- Root: no structured logging of skill activation, routing success/failure, or delivery events (PRs outside agent context)
- Negative cases (should-route-but-did-not) never captured

### 3. Cross-Project Silos
- AIstudy: 4 agents + 2 skills + 5 prompts + better-harness reports (2 rounds)
- cengfan: custom agents (temp-luna, tokenfree-luna) + cengfan-data-import skill + subagent runs
- better-harness (QoderAI): 4 meta-skills (harness-skill-creator, change-traceability-review, etc.) + detailed AGENTS.md
- Pi core: no .pi/, no self-review harness, skills only at user level

No sharing path for reusable assets (aistudy-git-workflow, cengfan-data-import)

### 4. Missing Meta-Skill
- No harness-friction-analyzer that ingests multi-project reports and proposes global fixes
- scenario-skill-router has no observability (which skills activated/skipped per session)

### 5. Verification & Delivery Gaps
- AGENTS.md contains failure→cause→fix→recheck + delivery discipline, but no enforcement template or lint
- reliable-delivery stuck at 45 because PR/acceptance happens in GitHub, not agent context
- No 4-step evidence chain in completion reports

### 6. Prompt Optimization Risks
- No dynamic section add/remove based on scenario similarity
- Overfit risk: project-specific agents (worker.md tool lists vary)
- Underfit risk: generic prompts ignore package-level AGENTS.md
- No versioning/A-B for prompt variants

## Routing to References

- references/skill-bloat.md — detection, pruning, usage metrics
- references/evidence-loop.md — closing "not observed" gaps, negative-case logging
- references/cross-project.md — sharing strategy, sync command proposal
- references/meta-skill.md — harness-friction-analyzer spec
- references/prompt-tuning.md — scenario-similarity router, dynamic composition, fit guardrails
- references/agent-config.md — drift detection, tool-allowlist enforcement, subagent error patterns

## Activation Rule
Only load 1-2 references per invocation. After analysis, propose the smallest durable fix (new reference, router update, or meta-skill) rather than one-off patches.
