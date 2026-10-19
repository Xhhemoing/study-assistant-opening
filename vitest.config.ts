import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, defineProject } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));
const openingDbSetup = path.resolve(root, "scripts/opening-test-db.mjs");

const alias = {
  "@aistudy/domain/span-heldout-catalog": path.resolve(root, "packages/domain/src/opening/span-heldout-catalog.ts"),
  "@aistudy/domain/exam-sprint-catalog": path.resolve(root, "packages/domain/src/opening/exam-sprint/catalog.ts"),
  "@aistudy/domain/measurement-catalog": path.resolve(root, "packages/domain/src/opening/measurement/catalog.ts"),
  "@aistudy/domain/native": path.resolve(root, "packages/domain/src/portability/native/index.ts"),
  "@aistudy/domain": path.resolve(root, "packages/domain/src/index.ts"),
  "@aistudy/contracts": path.resolve(root, "packages/contracts/src/index.ts"),
  "@aistudy/database": path.resolve(root, "packages/database/src/index.ts"),
  "@aistudy/database/migrate": path.resolve(
    root,
    "packages/database/src/migrate.ts",
  ),
  "@aistudy/ai/model-routing": path.resolve(root, "packages/ai/src/model-routing.ts"),
  "@aistudy/ai": path.resolve(root, "packages/ai/src/index.ts"),
  "@aistudy/config/public": path.resolve(root, "packages/config/src/public/index.ts"),
  "@aistudy/config": path.resolve(root, "packages/config/src/index.ts"),
  "@aistudy/ui": path.resolve(root, "packages/ui/src/index.ts"),
  // Tests execute server modules in Node; resolve the marker like the
  // react-server condition does (no-op) instead of the client-throwing entry.
  "server-only": path.resolve(root, "node_modules/server-only/empty.js"),
  "@aistudy/jingwei/react": path.resolve(root, "packages/jingwei/src/react/index.ts"),
  "@aistudy/jingwei": path.resolve(root, "packages/jingwei/src/index.ts"),
};

const sharedExclude = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/coverage/**",
];

export default defineConfig({
  test: {
    // CI is isolated; keep parallel unit/contract work bounded there while
    // retaining the small shared development host's single-worker default.
    maxWorkers: process.env.CI === "true" ? 4 : 1,
    projects: [
      defineProject({
        resolve: { alias },
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.{ts,tsx}", "apps/*/src/**/*.test.{ts,tsx}"],
          exclude: sharedExclude,
          environment: "node",
        },
      }),
      defineProject({
        resolve: { alias },
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "handler",
          include: ["tests/integration/handler/**/*.test.ts"],
          setupFiles: [path.resolve(root, "tests/integration/handler/auth-rate-limit-setup.ts")],
          exclude: sharedExclude,
          environment: "node",
          fileParallelism: false,
          globalSetup: [openingDbSetup],
        },
      }),
      defineProject({
        resolve: { alias },
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          exclude: [...sharedExclude, "**/tests/integration/handler/**"],
          environment: "node",
          fileParallelism: false,
          globalSetup: [openingDbSetup],
        },
      }),
      defineProject({
        resolve: { alias },
        test: {
          name: "contract",
          include: ["tests/contract/**/*.test.ts"],
          exclude: sharedExclude,
          environment: "node",
        },
      }),
      defineProject({
        test: {
          name: "notion-pipeline",
          include: ["scripts/notion-meeting-pipeline/**/*.test.mjs"],
          exclude: sharedExclude,
          environment: "node",
        },
      }),
      "spikes/*/vitest.config.ts",
    ],
  },
});
