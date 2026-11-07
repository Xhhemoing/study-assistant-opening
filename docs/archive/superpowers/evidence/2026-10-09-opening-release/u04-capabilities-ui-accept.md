# U04 Capabilities UI accept — connections / knowledge / action-digest / media-reader

**Date:** 2026-10-09 ~18:21 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Workspace:** `/workspace/study-assistant-opening`  
**Scope:** Integrator accept of **U04** against `docs/superpowers/plans/opening-release/11-proactive-acceptance.md` § U04 — connection controls, knowledge view, one daily action surface, media reader, e2e case+fixture written.  
**Verdict:** **ACCEPT** (agent-owned unit/UI slice)  
**U04 verified:** **not marked** — browser/e2e not run (`E2E_DATABASE_URL` unset / fixture DB required).  
**Browser:** **not run** — do not claim browser pass.  
**tasks.json:** **not edited**.  
**Commit/push:** **not done**.

## Files reviewed

**Create (matched plan Create / claimed)**
- `apps/web/src/features/opening/connections/connection-settings.tsx` (178 lines ≤200) — list/create IMAP, credential (password input, clear after submit), sync/pause/revoke, manual `.eml` import marked 手工
- `apps/web/src/features/opening/connections/connection-status.tsx` (+ `connection-status.test.ts`) — `等待授权` label, scopes/sync/error, unavailable for revoked/disabled, `shouldClearSecretAfterSubmit`
- `apps/web/src/features/opening/knowledge/course-knowledge.tsx` (+ `course-knowledge.test.ts`) — chapters + next step first; expandable graph; unavailable ≠ sample; no mastery %
- `apps/web/src/features/opening/knowledge/knowledge-evidence.tsx` — material / video / problem / evidence targets from node
- `apps/web/src/features/opening/planning/action-digest.tsx` (+ `action-digest.test.ts`) — Today ≤3 primary copy + concentrated confirm card (accept/修改/拒绝/查看依据); alias `ActionDigestCard`
- `apps/web/src/features/opening/sources/media-reader.tsx` (+ `media-reader.test.ts`) — separate states: parse_failed_original_saved / audio_only_transcript / insufficient_visual_coverage / unavailable
- `apps/web/src/app/(opening)/opening/settings/connections/page.tsx` — `/opening/settings/connections`
- `tests/e2e/opening-capabilities.spec.ts` — plan fixture case `shows authorization failure…` asserts exact `等待授权`; plus today/course no-mastery cases
- `tests/e2e/opening-capability-fixture.ts` — `seedCapabilityAccount` → `{cookie, connectionId, courseId, dispose}`; requires `E2E_DATABASE_URL`; C01 unauthorized IMAP; no `page.route` API fake

**Modify (matched claim)**
- `apps/web/src/features/opening/client/api.ts` — `listConnections` / `createImapConnection` / `putConnectionCredential` / `syncConnection` / `revokeConnection` / `importEmailManual` / `getSourceSegments` (+ existing `getCourseKnowledge` / `getActionDigest`)
- `apps/web/src/features/opening/planning/today-view.tsx` — mounts `ActionDigest` card on Today
- `apps/web/src/features/courses/course-detail.tsx` — `CourseKnowledge` + `MediaReader` wiring; copy separates media failure modes; no mastery meter
- Settings/assistant entries — `settings-view.tsx` link to `/opening/settings/connections`; `assistant-view.tsx` link “数据连接与授权” (unavailable ≠ sample)

**Also present (helpers used by U04 surface; counted in claimed unit set)**
- `apps/web/src/features/opening/planning/action-digest-card.test.ts` — empty digest / decide_fail keep digest (P04 card helpers reused by U04 surface)

## Plan checklist (agent-owned slice)

| # | Criterion (from § U04) | Result | Notes |
|---|---|---|---|
| 1 | Browser fail test written: `等待授权` via fixture | **PASS (written)** | Exact plan test in `opening-capabilities.spec.ts`; fixture seeds unauthorized IMAP |
| 2 | Connections: scopes / sync / error / pause / revoke; no secret echo; clear after submit | **PASS (code)** | Status details + password type; clear on success; pause UI local |
| 3 | Manual import marked manual, not auto sync | **PASS (code)** | Copy + notice: 「手工」「不是自动邮箱同步」 |
| 4 | Course: chapters + next step first; knowledge expandable; evidence targets | **PASS (code)** | Graph behind “展开知识关系”; `KnowledgeEvidence` links |
| 5 | Media: parse-failed / audio-only / insufficient visual separate | **PASS (code+unit)** | `classifyMediaReaderState` + copy |
| 6 | Today ≤3 + one confirm card; accept/modify/reject/basis | **PASS (code)** | UI + helpers; primary cap is domain digest (P04); surface concentrates confirmations |
| 7 | Unavailable ≠ sample; no mastery % | **PASS (code+unit)** | Empty/unavailable copy; no mastery strings in U04 UI paths |
| 8 | Components ≤200 lines; real API client (no page.route fake) | **PASS** | All Create components ≤178; fixture documents no route fake |
| 9 | Browser e2e green / responsive / file pick / cross-device | **GAP** | Not run — see gaps |

## Tests re-run (actual)

```text
node node_modules/vitest/vitest.mjs run --project unit \
  apps/web/src/features/opening/connections/connection-status.test.ts \
  apps/web/src/features/opening/knowledge/course-knowledge.test.ts \
  apps/web/src/features/opening/sources/media-reader.test.ts \
  apps/web/src/features/opening/planning/action-digest.test.ts \
  apps/web/src/features/opening/planning/action-digest-card.test.ts
# → Test Files  5 passed (5)
# → Tests  11 passed (11)
# Breakdown: connection-status 4 + course-knowledge 2 + media-reader 2 + action-digest 1 + action-digest-card 2 = 11
# Matches claimed unit 11/5
```

**tsc (optional, run):**
- `npx tsc -p apps/web --noEmit` → exit 0

**Not run:**
- `npm run test:browser -- tests/e2e/opening-capabilities.spec.ts` — no `E2E_DATABASE_URL` / fixture DB; browser not claimed
- Integration / full suite beyond claimed unit files

## Known gaps (ACCEPT slice; U04 not verified)

1. **Browser / e2e not run** — Playwright case + fixture written (包括「等待授权」), but execution needs `E2E_DATABASE_URL` and live web; do not mark verified.
2. **Fixture DB required** — `seedCapabilityAccount` throws without `E2E_DATABASE_URL`; isolation account + unauthorized connection not exercised live this accept.
3. **Plan browser extras not evidenced** — 390×844 / 1440×900, keyboard focus, long titles, video seek, offline/refresh cross-device screenshots, real mobile file pick — not run.
4. **Pause is page-local** — `pausedIds` Set blocks sync requests in UI; server connection state still shown via badge (not a silent auto-sync claim).
5. **Video evidence `startMs` often null** — evidence target links to library materials; deep seek depends on media-reader `onSeek` / material open (code path present; browser not proven).
6. **U04 not verified** — full U04 stays open until browser e2e green against real fixture DB (+ Q04 as applicable).
7. **tasks.json not edited**; **no commit/push**.

## Verdict

**ACCEPT** — U04 Create/Modify match plan; behavior claims for no secret echo, manual import marking, expandable knowledge, separate media failure states, unavailable ≠ sample, and no mastery % hold in code review; related unit **11**/5 green; web tsc green. **Not verified** — browser/e2e and fixture DB gaps remain.
