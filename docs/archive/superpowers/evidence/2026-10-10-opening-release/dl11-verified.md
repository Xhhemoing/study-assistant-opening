# DL11 — verified

**Date:** 2026-10-10 ~01:03 CST (Asia/Shanghai)  
**Owner:** DATA (+ Experience UI/submit surface)  
**Status:** **verified**

## AC met (`15-research-hardening` §DL11)
1. Domain day-planner earliest: `max(slot.start, recommendedAt/notBefore, planningNow)` — Accept `dl11-day-planner-earliest-accept.md`
2. plan-service wiring: server `planningNow` + TZ01 `localDate`/`timeZone` — Accept `dl11-plan-service-planningnow-accept.md` @ `17b29ef`
3. Submit reject-early (server): attempt-service + observations dual gate — Accept `dl11-retest-submit-reject-early-accept.md` + Data closeout @ `1d5c69e`

## Not claimed
- Q03 packaging/restore (separate, still active)
- Prod cutover
