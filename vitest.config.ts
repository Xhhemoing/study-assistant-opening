import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, defineProject } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

const alias = {
  "@aistudy/domain": path.resolve(root, "packages/domain/src/index.ts"),
  "@aistudy/contracts": path.resolve(root, "packages/contracts/src/index.ts"),
  "@aistudy/database": path.resolve(root, "packages/database/src/index.ts"),
  "@aistudy/database/migrate": path.resolve(
    root,
    "packages/database/src/migrate.ts",
  ),
  "@aistudy/ai": path.resolve(root, "packages/ai/src/index.ts"),
  "@aistudy/config": path.resolve(root, "packages/config/src/index.ts"),
  "@aistudy/ui": path.resolve(root, "packages/ui/src/index.ts"),
};

const sharedExclude = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/coverage/**",
];

export default defineConfig({
  test: {
    maxWorkers: 1,
    projects: [
      defineProject({
        resolve: { alias },
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          exclude: sharedExclude,
          environment: "node",
        },
      }),
      defineProject({
        resolve: { alias },
        test: {
          name: "handler",
          include: ["tests/integration/handler/**/*.test.ts"],
          exclude: sharedExclude,
          environment: "node",
          fileParallelism: false,
        },
      }),
      defineProject({
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          exclude: [...sharedExclude, "**/tests/integration/handler/**"],
          environment: "node",
          fileParallelism: false,
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
      "spikes/*/vitest.config.ts",
    ],
  },
});
