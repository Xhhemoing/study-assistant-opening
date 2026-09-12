# Release Verification and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans; release requires observed evidence, not plan checkboxes.

**Goal:** Prove the opening release works with real APIs, survives failures and protects personal data.
**Architecture:** Tests use an isolated DB and controlled provider fixtures; real model/mobile observations are separate evidence. Deployment remains a separately authorized action.
**Tech Stack:** Vitest, Playwright, Docker Compose, PostgreSQL/Redis/S3, existing Next.js build.

## Global Constraints

No production test connection. No fabricated reviewer, CI success, screenshot, API cost or model quality. Capture failing cases as regression fixtures after redaction. Runtime alerts require actual configuration before claiming continuous supervision.

### Q01: Cross-module negative and concurrency tests

**Owner:** QA. **Depends:** U03,Q03.
**Create:** `tests/integration/handler/opening-loop.test.ts`, `tests/integration/opening-concurrency.test.ts`, `tests/integration/opening-failure-recovery.test.ts`, `tests/contract/opening-safety-boundaries.test.ts`.
**Modify:** `tests/integration/opening-backup-privacy.test.ts` (Q03 creates it before this task).
**Interfaces:** reuse F03 fixture; no separate mock business database. Test helper may inject provider/storage/clock only at existing runtime boundaries.

- [ ] Write failing acceptance before patching implementation, e.g.:
```ts
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOpeningFixture, type OpeningFixture } from '../opening-fixture';
let f: OpeningFixture;
beforeAll(async()=>{f=await createOpeningFixture();});
afterAll(async()=>{await f?.close();});
it('does not permit anonymous access to memory', async()=>{
  const r=await f.requestAnonymous('/api/opening/memory');
  expect(r.status).toBe(401);
});
```
`requestAnonymous`构造不含cookie的普通请求；不增加可改变生产鉴权行为的测试请求头。
- [ ] Run guarded handler test red, then add real two-principal cases for sources, conversations, memory, learning and plans.
- [ ] Exercise complete saved flow: upload -> parse -> tutor -> observation -> memory proposal/confirmation -> plan proposal/accept -> retest. Assertions inspect actual DB rows and returned versions, not only HTTP200.
- [ ] Fault cases: lost reply after commit, worker crash before/after model response, stale plan accept, deletion during writeback, file MIME spoof, source prompt injection, unconfigured provider and budget exhaustion. Every bug fix has a regression tied to its failure ID.
- [ ] Run unit/contract/handler/integration gates on isolated services. Core negative tests require zero unauthorized reads/writes in the tested cases. Backup checks run against completed Q03 implementation before Q01 can be verified.

### Q02: Mobile workflow and model-quality samples

**Owner:** QA. **Depends:** Q01.
**Create:** `tests/e2e/opening-fixture.ts`, `tests/e2e/opening-real-loop.spec.ts`, `tests/e2e/opening-mobile-states.spec.ts`, `tests/evaluation/opening-cases.json`, `scripts/evaluate-opening.mjs`, `docs/superpowers/evidence/opening-acceptance-template.md`.
**Interfaces:** `seedFailedParseSource(page:Page,request:APIRequestContext):Promise<{courseId:string;dispose():Promise<void>}>` creates an isolated owner, obtains a real login cookie, uploads a valid synthetic PDF into test storage and transactionally marks its parse job failed/cancelled in the test DB before returning. It adds the owner's cookie to the browser context; dispose removes only that fixture's namespace. The fixture never uses page.route to mock business APIs. Evaluator takes `--cases <file> --output <file> --mode offline|live`; live requires explicit configured budget and `--allow-paid`, no default paid calls. Cases include ID, source kind, expected evidence/error, reference and provenance(synthetic/real).

- [ ] Add failing browser acceptance:
```ts
import { test, expect } from '@playwright/test';
import { seedFailedParseSource } from './opening-fixture';
test('mobile user sees parsing failure without losing original', async({page,request})=>{
  const fixture = await seedFailedParseSource(page,request);
  try {
    await page.setViewportSize({width:390,height:844});
    await page.goto('/opening/courses/'+fixture.courseId);
    await expect(page.getByRole('navigation')).toBeVisible();
    await expect(page.getByText('原件已保存，解析失败')).toBeVisible();
    await expect(page.getByRole('button',{name:'查看原件'})).toBeEnabled();
  } finally {
    await fixture.dispose();
  }
});
```
Fixture setup uses only F01-guarded test DB/storage; it tests actual UI state for known server records, not the accuracy of the parser.
- [ ] Run browser test red; complete all fixture setup and selectors before treating it as a gate. No incomplete sample test is allowed into CI.
- [ ] Automated matrix:390x844 mobile,1440x900 desktop; upload/retry, source navigation, equation overflow, keyboard focus, reload conversation, memory correction/delete, ephemeral refresh, plan409, failed model, quiet reminder. Use real application API and DB for final loop; fake provider only isolates deterministic fault cases.
- [ ] Real-device checklist separately covers camera/file picker, orientation and browser background interruption. Real-model set includes at least handwriting ambiguity, English terminology, an incorrect derivation, unsupported proof, missing source and emotional conversation. Record errors and latency/cost; distinguish citation existence from semantic correctness. No numerical accuracy claim without denominator and sampling limits.
- [ ] Generate report with exact command, environment, case provenance, pass/fail/manual/block status and artifacts. Handwriting/audio quality not measured -> explicitly blocked, not inferred from synthetic text tests. A successful demo is not broad educational-effectiveness evidence.

### Q03: Production image, backup recovery and operational supervision

**Owner:** INTEGRATOR+QA. **Depends:** P03,M02. Packaging and backup verification precede Q01/Q02; this task does not authorize deployment or certify final user experience.
**Create:** `tests/integration/opening-backup-privacy.test.ts`, `infra/docker/Dockerfile.opening-web`, `infra/docker/Dockerfile.opening-worker`, `infra/docker/compose.opening.yml`, `infra/docker/opening.env.example`, `apps/web/src/app/api/opening/health/route.ts`, `packages/database/src/repositories/opening-backup.ts`, `scripts/opening-backup.ts`, `scripts/opening-restore.ts`, `scripts/opening-readiness.mjs`, `docs/operations/opening-release.md`.
**Interfaces:** `OpeningBackup={format:'opening-backup';version:1;workspaceId:string;privacyEpoch:number;deletionJournal:Array<{sourceId:string;deletedAt:string}>;tables:Record<string,unknown[]>;objects:Array<{sourceId:string;sha256:string;bytes:number;archivePath:string}>}`; `RestorePreview={allowed:boolean;errors:string[];recordCounts:Record<string,number>}`. `exportOpeningBackup(scope):Promise<OpeningBackup>`; `validateOpeningRestore(backup,currentDeletionJournal):RestorePreview`; table names must match the fixed server schema allowlist, never interpolated from arbitrary backup keys. Apply requires explicit local confirmation flag and never restores API keys/sessions or auto-replays pending paid jobs. Backup format is versioned and includes original hashes, source lineage and privacy epochs.

- [ ] Add failing tests first for restored deleted-memory exclusion, wrong source hash, unknown backup version and non-owner access in `tests/integration/opening-backup-privacy.test.ts`.
- [ ] Run guarded backup tests red. Build profiles separate web from parser-heavy worker; only worker includes isolated Python/Docling runtime. Do not mount Docker socket or expose an arbitrary shell tool to AI.
- [ ] Compose uses loopback/internal DB/Redis/S3 bindings, mandatory non-default credentials, named volumes, health checks, CPU/memory limits and restart policy. TLS reverse proxy handles request limits and streaming configuration if streaming is enabled. Never deploy the existing development compose with public default-password databases.
- [ ] Backup includes DB+objects consistency manifest; encrypt off-host backups, keep secrets separate, define retention and deletion journal handling. Restore into a new empty test DB/storage namespace, verify hashes and privacy exclusions, then run the learning loop. Pending jobs restore cancelled until explicitly recreated, preventing unexpected paid calls.
- [ ] Add readiness checks for owner setup, registration403, HTTPS, storage, DB/Redis/worker heartbeat, configured provider status, daily cap and backup freshness. Alerts expose metadata only. Unconfigured alert destination means monitoring exists locally but nobody is receiving alerts; show this honestly.
- [ ] Run packaging gates: lint, typecheck, guarded backup/privacy tests, production build and restore drill. Supply artifacts to Q01 and Q02, which then run the complete final sequence: verify:ci, lint, typecheck, unit/contract, integration/handler, browser and build. Record blocked items. Purchase, public deployment, actual server changes and production migration require authorization/configuration; do not claim deployed from a successful local image build.

**Release decision:** all five core functions must work on real API flow; data/auth/delete/restore gates mandatory. Optional transcription or external push may be labelled unavailable only as agreed scope fallback. Signed-off evidence means actual observed checks, not a model's assurance of perfection.
