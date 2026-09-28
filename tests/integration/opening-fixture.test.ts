import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createSqlClient } from "@aistudy/database";
import { createOpeningFixture } from "./opening-fixture";

it("closes the database connection when fixture initialization fails after user inserts", async () => {
  const url = new URL(process.env.DATABASE_URL!);
  const sql = createSqlClient(url.toString(), { max: 1 });
  const applicationName = `opening_fixture_failure_${randomUUID()}`;
  try {
    const [before] = await sql`SELECT count(*)::int AS count FROM users`;
    url.searchParams.set("application_name", applicationName);
    vi.stubEnv("OPENING_TEST_DATABASE_URL", url.toString());
    vi.stubEnv("AUTH_SECRET", "");

    await expect(createOpeningFixture()).rejects.toMatchObject({ name: "DataError" });

    const [after] = await sql`SELECT count(*)::int AS count FROM users`;
    expect(after.count).toBe(before.count + 2);
    const [connections] = await sql`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE application_name = ${applicationName}
    `;
    expect(connections.count).toBe(0);
  } finally {
    vi.unstubAllEnvs();
    await sql.end({ timeout: 5 });
  }
});
