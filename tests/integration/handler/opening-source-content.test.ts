import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpeningSourceChunksRepository } from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { GET } from "../../../apps/web/src/app/api/opening/sources/[id]/content/route";
let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;
const request = (id: string, query = "", auth = true) => new Request(`http://localhost/api/opening/sources/${id}/content${query}`, { headers: auth ? { cookie: f.cookie } : {} });
const context = (id: string) => ({ params: Promise.resolve({ id }) });
beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({ databaseUrl: process.env.OPENING_TEST_DATABASE_URL!, authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    sessionCookieSecure: false, sessionTtlSeconds: 3600, authCookieName: "aistudy_session" });
  setAuthRuntimeForTests(runtime);
});
afterAll(async () => { setAuthRuntimeForTests(null); await runtime?.close(); await f?.close(); });
async function seed(workspaceId = f.scope.workspaceId) {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state) VALUES
    (${id},${workspaceId},'notes.pdf','application/pdf',8,${'ab'.repeat(32)},0,'uploaded','running')`;
  return id;
}
describe("parsed source content handlers", () => {
  it("requires authentication and does not disclose foreign content", async () => {
    const id = await seed(f.otherScope.workspaceId);
    expect((await GET(request(id, "", false), context(id))).status).toBe(401);
    expect((await GET(request(id), context(id))).status).toBe(404);
  });
  it("serves bounded version-pinned plain text with no private object keys", async () => {
    const id = await seed();
    await createOpeningSourceChunksRepository(f.sql).replaceChunks(f.scope, { sourceId: id, sourceVersion: 0,
      chunks: [{ page: 1, text: "<script>plain text only</script>", imageObjectKey: "secret/private-page", slideLabel: null, startMs: null, endMs: null }] });
    const response = await GET(request(id, "?version=0&page=1"), context(id));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({ sourceId: id, version: 0, page: 1, text: "<script>plain text only</script>", truncated: false });
    expect(JSON.stringify(body)).not.toContain("secret/private-page");
    expect((await GET(request(id, "?page=99"), context(id))).status).toBe(404);
  });
  it.each(["?page=0", "?page=1.5", "?version=-1", "?version=NaN", "?page="])('rejects invalid query %s', async query => {
    const id = randomUUID();
    expect((await GET(request(id, query), context(id))).status).toBe(400);
  });
  it("refuses an unfinished current parse rather than returning fake empty content", async () => {
    const id = await seed();
    expect((await GET(request(id), context(id))).status).toBe(409);
  });
});
