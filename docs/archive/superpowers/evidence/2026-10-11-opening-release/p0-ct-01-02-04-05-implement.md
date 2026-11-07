# P0 — CT-01 / CT-02 / CT-04 / CT-05 course UX IMPLEMENT

**Date:** 2026-10-11（Asia/Shanghai / CST）  
**Agent:** AIstudy Experience  
**Branch tip (baseline when started):** `8dcbbf6`（`feat/opening-release`）  
**Status:** IMPLEMENT complete — **uncommitted**；no push / hermes / stash / reset  
**Authorized:** Paula via PM — CT-01, CT-02, CT-04, CT-05 only；**CT-03 explicitly not implemented**

## Outcome

| ID | Shipped? | Summary |
|---|---|---|
| **CT-01** | Yes | Course detail IA: single primary practice CTA; practice before knowledge; materials in `<details>`; settings folded; media = list + mount **one** `MediaReader` on select |
| **CT-02** | Yes | Practice first screen slimmed to 选主题 → 作答 → 保存；材料/题干/帮助等级 in details；辅导默认收起在底部。**未**改 CTA 为 Today/主讲（needs CT-03 / V2-04） |
| **CT-03** | **No** | Untouched — Today / teaching-activity wiring deferred |
| **CT-04** | Yes | Removed dead `#evidence-*` hashes；video honest copy or course-media deep link with seek only when source+startMs known |
| **CT-05** | Yes | First tutor action → clickable CTA（`?skillLabel=…#course-practice` or `#course-assets` for clarify）；empty actions → honest empty, no fake buttons |

## Files changed（Experience only）

| Path | Change |
|---|---|
| `apps/web/src/features/courses/course-detail.tsx` | IA reorder; `CourseMediaSection` + `readCourseMediaDeepLink`; materials `<details>` |
| `apps/web/src/features/courses/course-detail.test.ts` | **new** — media list without reader; deep-link parse |
| `apps/web/src/features/courses/course-study-actions.tsx` | Single primary CTA; drop competing `#course-assets` same-level button |
| `apps/web/src/features/courses/course-study-actions.test.ts` | Align CT-01/02 expectations |
| `apps/web/src/features/courses/course-settings-panel.tsx` | Default `<details>` fold（CT-09 spirit） |
| `apps/web/src/features/opening/learning/attempt-form.tsx` | Slim 3-step UX; skillLabel query prefill; help at bottom collapsed |
| `apps/web/src/features/opening/learning/course-view.tsx` | Practice intro copy → 三步 |
| `apps/web/src/features/opening/knowledge/knowledge-evidence.tsx` | Honest evidence/video targets（CT-04） |
| `apps/web/src/features/opening/knowledge/course-knowledge.tsx` | `nextStepCta` + clickable CTA / empty state（CT-05） |
| `apps/web/src/features/opening/knowledge/course-knowledge.test.ts` | CT-04/05 helpers |
| `docs/superpowers/evidence/2026-10-11-opening-release/p0-ct-01-02-04-05-implement.md` | This evidence |

## Explicit non-touches

- **CT-03 / V2-04:** no edits to `packages/database`, `packages/domain` backup/learning, `packages/contracts` teaching-activity*, `apps/web/src/features/opening/teaching/`
- No Today dashboard / resume wiring
- No push / hermes / stash / reset / commit

## Gates

```bash
# targeted vitest — 4 files, 25 tests passed
npx vitest run \
  apps/web/src/features/courses/course-study-actions.test.ts \
  apps/web/src/features/courses/course-detail.test.ts \
  apps/web/src/features/opening/knowledge/course-knowledge.test.ts \
  apps/web/src/features/opening/learning/course-view.test.ts

# apps/web tsc — exit 0
cd apps/web && npx tsc --noEmit -p tsconfig.json
```

| Gate | Result |
|---|---|
| vitest (targeted) | **25 passed** / 4 files |
| `apps/web` tsc `--noEmit` | **exit 0** |

## Accept ask（Integrator）

请 Accept **P0 CT-01/02/04/05 Experience IMPLEMENT** 当且仅当：

- [ ] CT-01：课程详情主路径清晰（一主 CTA + 材料/设置折叠 + 媒体按选挂载）
- [ ] CT-02：练习首屏为三步；辅导默认收起；**未**把主 CTA 改成 Today 主讲
- [ ] CT-04：无死 `#evidence-*`；视频无假 seek，诚实文案或可 seek 深链
- [ ] CT-05：有 action 时可点 CTA；空 action 诚实空态、无假按钮
- [ ] CT-03 未实现；未污染 V2-04 dirty tree 路径
- [ ] 证据内 gates 可复现；改动仍 uncommitted（Integrator 合入策略另定）

**不**将本证据视为 CT-03 / V2-04 Today wiring 已上线。

## FYI — room-ready summary（parent）

Experience shipped **CT-01/02/04/05** on `feat/opening-release` (uncommitted): course detail IA slimmed to one practice CTA + collapsible materials/settings + single media reader on select; practice form default 选主题→作答→保存 with help collapsed; evidence links no longer invent `#evidence-*`; video either opens course media (seek only when source+ms known) or says 「仅打开材料库，暂不能定位」; knowledge 「下一步」 is a real CTA or honest empty. **CT-03 untouched.** Vitest 25 pass + web tsc clean. Ready for Integrator Accept.
