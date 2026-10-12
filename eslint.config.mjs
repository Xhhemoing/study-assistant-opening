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
  {
    // Jingwei core stays host-agnostic so other apps and agents can reuse it.
    files: ["packages/jingwei/src/**/*.ts"],
    ignores: ["packages/jingwei/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@aistudy/*"], message: "jingwei core must not depend on other AIstudy packages; adapt in the host." },
            { group: ["react", "react-dom", "next", "next/*"], message: "jingwei core is framework-free." },
            { group: ["node:*"], message: "jingwei core must run in browsers and workers." },
          ],
        },
      ],
    },
  },
);
