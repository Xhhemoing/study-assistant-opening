// Offline fixture-only entry point. Does not replace root integration/PG setup.
import { fileURLToPath } from "node:url";
// Plain config also works when the existing Vitest is run from an isolated prefix.
export default {
  root: fileURLToPath(new URL("../../../", import.meta.url)),
  test: {
    name: "sprint-pack-fixtures-offline",
    include: ["tests/integration/sprint-pack-fixtures.test.ts"],
    environment: "node",
    maxWorkers: 1,
    fileParallelism: false,
  },
};
