# Evidence Boundary Closure

## Problem
80%+ harness dimensions remain "not observed in this boundary" because:
- No structured logging of skill activation, routing outcome, or delivery events
- PR/acceptance decisions live in GitHub, outside agent context
- Negative cases (should-route-but-did-not) are invisible

## Observed Data
- AIstudy better-harness: 2 rounds, learning-capture 38→44, reliable-delivery stuck at 45
- Subagent runs contain "failed" status with "Unknown agent" errors, no root-cause capture

## Fix Direction
1. Mandate `.pi/logs/` with:
   - skill-routes.jsonl (task hash, activated skills, skipped skills, reason)
   - delivery-events.jsonl (PR created/merged, acceptance verdict, rollback recorded)
2. Negative-case reporter: when router skips a skill that matches >70% of past successful triggers, log warning
3. Completion template in AGENTS.md requires 4-step evidence chain (failure→cause→fix→recheck) with command output

## Validation
- After implementation, re-run harness report; "not observed" count must drop below 30%
