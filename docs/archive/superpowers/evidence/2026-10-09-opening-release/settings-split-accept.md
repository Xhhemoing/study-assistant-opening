# Settings page split accept — `/settings` vs `/settings/advanced`

**Date:** 2026-10-09 ~22:30 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`  
**Repo:** `/workspace/study-assistant-opening`  
**Scope:** Experience claim — settings page split + command palette entry only.  
**Verdict:** **ACCEPT**  
**Browser / e2e:** **not run** — gap noted below.  
**tasks.json:** no matching task id for settings-split; **not edited**; **verified** not marked.  
**Commit/push:** not done (not asked).

## Claim checked

| Claim | Result | Notes |
|---|---|---|
| `/settings`: anchor nav 连接·排程·学习偏好·高级 | **PASS** | `settings-view.tsx` nav: `#connections` / `#planning` / `#preferences` + Link `/settings/advanced` labeled 高级 |
| Main keeps closed-loop only | **PASS** | Sections: 数据连接, 开学排程, 学习偏好 only; AI/defaults/etc. pointed to advanced |
| `/settings/advanced`: AI/provider/defaults/guidance/autonomy/export link/demo/diagnostics | **PASS** | `AiSettingsPanel`, `ProviderSettingsPanel`, 默认入口, 指导模式, 计划自主权, Link `/settings/export`, 演示数据, `DiagnosticsPanel` |
| Back to main | **PASS** | PageHeading action Link `href="/settings"` 「返回设置」 |
| Files listed present | **PASS** | See spot-check below |
| Palette adds `settings-advanced` | **PASS** | `command-palette-model.ts` id `settings-advanced` → `/settings/advanced` |
| Export routes/API unchanged | **PASS** | `settings/export/page.tsx` and API `exports/markdown`, `exports/anki`, `backups/export` still present; advanced only links to export page |

## Files spot-checked (exist)

| Path | Role |
|---|---|
| `apps/web/src/features/settings/settings-view.tsx` | Main settings (loop only + advanced link) |
| `apps/web/src/features/settings/advanced-settings-view.tsx` | Advanced settings view |
| `apps/web/src/features/settings/settings-shared.ts` | Shared prefs helpers / switches |
| `apps/web/src/app/(workspace)/settings/advanced/page.tsx` | Route → `AdvancedSettingsView` |
| `apps/web/src/features/settings/settings-view.nav.test.ts` | Structure unit tests |
| `apps/web/src/features/search/command-palette-model.ts` | Palette entry `settings-advanced` (modified) |

## Tests re-run

```text
npx tsc -p apps/web/tsconfig.json --noEmit
→ exit 0 (no output)

npx vitest run --project unit \
  apps/web/src/features/settings/settings-view.nav.test.ts \
  apps/web/src/features/search/command-palette-model.test.ts
→ Test Files  2 passed (2)
→ Tests       6 passed (6)
→ Duration    ~718ms
```

## Gaps / observations (non-blocking for this accept)

- **No e2e / browser** for `/settings` or `/settings/advanced` navigation, scroll anchors, or palette open → advanced.
- Palette unit test asserts Opening loop ids via `arrayContaining` but does **not** explicitly assert `settings-advanced`; entry is present in model and suite still green (6/6).
- No `tasks.json` id matched for this split → did not mark verified.

## Recommendation

**ACCEPT** settings page split Experience claim. Do **not** mark `tasks.json` verified (no task id). No commit/push.
