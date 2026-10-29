import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// Use fresh native ESM processes: transformed test modules can hide initialization cycles.
for (const entry of [
  "./packages/contracts/src/opening/teaching-activity.ts",
  "./packages/contracts/src/opening/learning.ts",
  "./packages/contracts/src/opening/tutor.ts",
  "@aistudy/contracts",
]) {
  test(`initializes ${entry} and preserves strict help snapshot validation in native ESM`, () => {
    const check = `
      import assert from 'node:assert/strict';
      await import(${JSON.stringify(entry)});
      const contracts = await import('@aistudy/contracts');
      const tutor = await import('./packages/contracts/src/opening/tutor.ts');
      const { helpInputSnapshotSchema, helpExposureSchema, studyExposureReceiptSchema } = contracts;
      assert.equal(helpInputSnapshotSchema, tutor.helpInputSnapshotSchema);
      const snapshot = {
        userTurnId: '00000000-0000-4000-8000-000000000001',
        assistantTurnId: '00000000-0000-4000-8000-000000000002',
        tutorMode: 'hint', studyIntent: null,
      };
      assert.deepEqual(helpInputSnapshotSchema.parse(snapshot), snapshot);
      const studyIntent = { intent: {
        purpose: 'self_study', timeBudgetMinutes: 45, language: 'zh', pace: 'normal',
        continuous: true, selfReportedFatigue: 'unknown',
      }, action: 'continue' };
      assert.deepEqual(helpInputSnapshotSchema.parse({ ...snapshot, studyIntent }).studyIntent, studyIntent);
      const consumers = [helpInputSnapshotSchema, helpExposureSchema.shape.helpInputSnapshot,
        studyExposureReceiptSchema.shape.helpInputSnapshot];
      for (const schema of consumers) {
        assert.deepEqual(schema.parse(snapshot), snapshot);
        for (const invalid of [
          { ...snapshot, tutorMode: 'invented' },
          { ...snapshot, userTurnId: 'invalid' },
          { ...snapshot, assistantTurnId: undefined },
          { ...snapshot, unexpected: true },
          { ...snapshot, studyIntent: { ...studyIntent, action: 'invented' } },
        ]) assert.equal(schema.safeParse(invalid).success, false);
      }
      for (const schema of consumers.slice(1)) {
        assert.equal(schema.parse(null), null);
        assert.equal(schema.parse(undefined), undefined);
      }
      process.stdout.write('ok');
    `;
    assert.equal(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", check], {
      cwd: repositoryRoot, encoding: "utf8",
    }), "ok");
  });
}
