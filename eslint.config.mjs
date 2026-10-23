import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.next-opening-e2e/**",
      "**/.next-preview/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "package-lock.json",
      "spikes/**",
      "apps/web/next-env.d.ts",
      // Agent/CI/tooling metadata directories are not project source.
      ".agents/**",
      ".claude/**",
      ".github/**",
      ".pi/**",
      // Local runtimes and scratch downloads are not project source.
      ".local/**",
      ".tmp/**",
      // Python virtualenvs (e.g. services/parser/.venv) are not project source.
      "**/.venv/**",
      "**/venv/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Plan §7.4 layering. Transitive Client-Component reachability is enforced by
  // scripts/check-server-boundary.mjs (run by `npm run lint`); these rules
  // catch direct illegal imports per layer. Type-only imports are erased and
  // allowed.
  {
    // Route handlers / server pages: auth + validation + call an application
    // service. Repositories and drivers are wired in server-only adapters.
    files: ["apps/web/src/app/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        patterns: [{
          group: ["@aistudy/database", "@aistudy/database/*", "postgres", "drizzle-orm", "drizzle-orm/*", "ioredis", "@aws-sdk/*"],
          allowTypeImports: true,
          message: "Routes/pages call application services (e.g. features/*/server/*); do not import repositories or drivers directly (plan §7.4).",
        }],
      }],
    },
  },
  {
    // Pure layers shared with worker/client: no data access, no web markers.
    files: ["packages/domain/src/**/*.ts", "packages/contracts/src/**/*.ts", "packages/ui/src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        patterns: [{
          group: ["@aistudy/database", "@aistudy/database/*", "postgres", "drizzle-orm", "drizzle-orm/*", "ioredis", "@aws-sdk/*", "server-only"],
          allowTypeImports: false,
          message: "domain/contracts/ui are pure layers and must not reach data access (plan §7.4).",
        }],
      }],
    },
  },
  {
    // Worker and worker-shared packages have their own entrypoints; the Web
    // `server-only` marker would throw outside the react-server condition.
    files: ["apps/worker/**/*.ts", "packages/ai/src/**/*.ts", "packages/config/src/**/*.ts", "packages/database/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        paths: [{ name: "server-only", message: "server-only is a Web server adapter marker; do not use it in worker or shared packages." }],
      }],
    },
  },
  {
    // UI v5：站内链接统一走带页面过渡的 TransitionLink（壳层外/测试中自动退回普通跳转）。
    files: ["apps/web/src/features/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "apps/web/src/features/auth/**", "apps/web/src/features/opening/v3/motion/view-transition.tsx"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        paths: [{ name: "next/link", message: "用 features/opening/v3/motion/view-transition 的 TransitionLink，跳转才有页面过渡。", allowTypeImports: true }],
      }],
    },
  },
  {
    // One model gateway: providers are built only from configured routes, so every
    // model call is selectable in settings and recorded in the budget ledger.
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    ignores: ["apps/worker/src/runtime/model-gateway.ts", "packages/ai/src/**", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "@aistudy/ai",
          importNames: ["createOpeningProvider"],
          message: "Call models through the model gateway (apps/worker/src/runtime/model-gateway.ts) and register the use in MODEL_TASKS.",
        }],
      }],
    },
  },
  {
    // Jingwei core stays host-agnostic so other apps and agents can reuse it.
    files: ["packages/jingwei/src/**/*.{ts,tsx}"],
    ignores: ["packages/jingwei/src/**/*.test.{ts,tsx}", "packages/jingwei/src/react/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@aistudy/*"], message: "jingwei core must not depend on other AIstudy packages; adapt in the host." },
            { group: ["react", "react-dom", "react/*", "next", "next/*"], message: "jingwei core is framework-free; React lives in src/react." },
            { group: ["node:*"], message: "jingwei core must run in browsers and workers." },
          ],
        },
      ],
    },
  },
  {
    // The React runtime may use React, but stays host-agnostic like the core.
    files: ["packages/jingwei/src/react/**/*.{ts,tsx}"],
    ignores: ["packages/jingwei/src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@aistudy/*"], message: "jingwei must not depend on other AIstudy packages; adapt in the host." },
            { group: ["next", "next/*"], message: "jingwei/react must work outside Next." },
            { group: ["node:*"], message: "jingwei must run in browsers and workers." },
          ],
        },
      ],
    },
  },
);
