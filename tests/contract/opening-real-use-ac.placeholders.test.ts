/**
 * Opening real-use AC placeholders (skeleton only).
 *
 * Source: docs/quality/opening-real-use-audit.md §5
 * Map: docs/superpowers/plans/opening-release/traceability.md
 *
 * Rules:
 * - Fold into existing suites when implementing; do not claim product pass while skipped.
 * - Real probe bodies wait for F02 verified (then F01 as needed).
 * - Fake provider = protocol checks; semantic gold labels = human.
 * - Release order Q03→Q01→Q02; early chat UI ≠ backup/delete/live-model/device acceptance.
 *
 * Shared gates: node scripts/validate-opening-plan.mjs;
 *   node --test tests/tooling/opening-plan.test.mjs;
 *   npx vitest run packages/contracts/src/opening/contracts.test.ts
 */
import { describe, it } from "vitest";

type AcPlaceholder = {
  id: string;
  ru: string;
  tasks: string;
  commands: string;
  hang: string;
};

const placeholders: AcPlaceholder[] = [
  {
    id: "AC01",
    ru: "mail/draft-course",
    tasks: "T03,P02,U03,Q02",
    commands: "npm test; npm run typecheck",
    hang: "none yet — extend tutor/planning when T03/P02 land",
  },
  {
    id: "AC02",
    ru: "appendix-honesty",
    tasks: "I02,T02,Q02",
    commands: "npm test",
    hang: "none yet — extend ingestion/tutor when I02/T02 land",
  },
  {
    id: "AC03",
    ru: "RU-01",
    tasks: "F01,F02,I01,U01,U03",
    commands:
      "npm run test:integration -- course-asset-identity; npm run typecheck",
    hang: "tests/integration/course-asset-identity.test.ts (document); source link/unlink awaits F02",
  },
  {
    id: "AC04",
    ru: "RU-03",
    tasks: "I02,T02,U02,Q02",
    commands: "npm test; npm run test:integration",
    hang: "evidence E02 physical page samples; no page-select probe yet",
  },
  {
    id: "AC05",
    ru: "unclear-photo",
    tasks: "I02,T01,T02,L01,Q02",
    commands: "npm test",
    hang: "none yet — multimodal/tutor when T01/T02 land",
  },
  {
    id: "AC06",
    ru: "RU-04",
    tasks: "T03,L01,L02,Q01",
    commands: "npm test; npm run test:integration",
    hang: "none yet — learningSession wash when L01/L02 land",
  },
  {
    id: "AC07",
    ru: "RU-02",
    tasks: "T02,T03,U03,Q02",
    commands: "npm test; later U03/T03",
    hang: "F02 ConversationResume contract; no cross-device resume probe yet",
  },
  {
    id: "AC08",
    ru: "schedule-gaps",
    tasks: "P01,P02,U03,Q01",
    commands: "npm test",
    hang: "F02 TimeConfig.version; no schedule conflict probe yet",
  },
  {
    id: "AC09",
    ru: "RU-06",
    tasks: "M01,M03,T02,P02,Q02",
    commands: "npm test",
    hang: "none yet — course-scoped preference when M01 lands",
  },
  {
    id: "AC10",
    ru: "verdict-labels",
    tasks: "L01,L02,Q02",
    commands: "npm test",
    hang: "none yet — learning observation labels when L01/L02 land",
  },
  {
    id: "AC11",
    ru: "weak-net-timeout",
    tasks: "I01,I03,T01,T03,U02,U03",
    commands: "npm test",
    hang: "none yet — idempotent upload/timeout when I01/I03 land",
  },
  {
    id: "AC12",
    ru: "reject-delete-restore",
    tasks: "M02,P02,Q03,Q01",
    commands: "npm test; npm run test:browser when backup e2e ready",
    hang: "tests/e2e/native-backup.spec.ts — do not claim opening AC12 until Q03",
  },
];

describe("opening real-use AC placeholders", () => {
  for (const ac of placeholders) {
    const title = [
      ac.id,
      `ru=${ac.ru}`,
      `tasks=${ac.tasks}`,
      `cmd=${ac.commands}`,
      `hang=${ac.hang}`,
    ].join(" | ");

    it.skip(title, () => {
      // Placeholder until F02 verified; implement in the hang suite named above.
    });
  }
});
