import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readOpeningMaterialOrganization } from "../../packages/database/src/repositories/opening-material-organization";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
let fixture: OpeningFixture;
beforeAll(async () => { fixture = await createOpeningFixture(); });
afterAll(async () => { await fixture?.close(); });

describe("material organization inventory", () => {
  it("keeps one material in multiple course spaces and reads only owned relationships", async () => {
    const source = randomUUID(), missing = randomUUID(), a = randomUUID(), b = randomUUID(), foreign = randomUUID();
    await fixture.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES
      (${a},${fixture.scope.workspaceId},'Calculus',${a}), (${b},${fixture.scope.workspaceId},'Physics',${b}),
      (${foreign},${fixture.otherScope.workspaceId},'Foreign',${foreign})`;
    await fixture.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state) VALUES
      (${source},${fixture.scope.workspaceId},'shared.pdf','application/pdf',8,${'ab'.repeat(32)},0,'uploaded','ready')`;
    await fixture.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility) VALUES
      (${fixture.scope.workspaceId},${a},'source',${source},'core','private'),
      (${fixture.scope.workspaceId},${b},'source',${source},'reference','private'),
      (${fixture.scope.workspaceId},${a},'source',${missing},'reference','private')`;
    const inventory = await readOpeningMaterialOrganization(fixture.sql, fixture.scope);
    expect(inventory.courses.map(item => item.id).sort()).toEqual([a,b].sort());
    expect(inventory.memberships.map(item => item.sourceId)).toEqual([source,source]);
    expect(inventory.memberships.map(item => item.role).sort()).toEqual(['core','reference']);
    const sources = await fixture.sql`SELECT count(*)::int AS n FROM opening_sources WHERE id=${source}`;
    expect(sources[0]?.n).toBe(1);
    await expect(readOpeningMaterialOrganization(fixture.sql, { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await readOpeningMaterialOrganization(fixture.sql, fixture.otherScope)).memberships).toEqual([]);
  });
});
