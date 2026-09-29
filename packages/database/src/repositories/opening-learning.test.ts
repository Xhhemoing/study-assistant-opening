import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningLearningRepository } from "./opening-learning";
const workspaceId="00000000-0000-4000-8000-000000000001", ownerUserId="00000000-0000-4000-8000-000000000002";
const courseId="00000000-0000-4000-8000-000000000003", sourceId="11111111-1111-4111-8111-111111111111";
const scope={ workspaceId, ownerUserId };
function db(handler: (query: string, values: unknown[]) => unknown[]) {
  const writes: string[]=[];
  const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Object.hasOwn(strings,"raw")) return strings;
    const query=strings.join("?");
    if (/INSERT|UPDATE|DELETE/.test(query)) writes.push(query);
    return Promise.resolve(handler(query,values));
  }) as unknown as Sql;
  sql.begin=((callback: (tx: Sql)=>unknown)=>callback(sql)) as Sql["begin"];
  return { sql,writes };
}
describe("opening learning boundaries",()=>{
  it("rejects a source outside the uploaded workspace snapshot before creating a session",async()=>{
    const {sql,writes}=db(query=>{
      if(query.includes("FROM workspaces")) return [{id:workspaceId}];
      if(query.includes("FROM courses")) return [{id:courseId}];
      return [];
    });
    await expect(createOpeningLearningRepository(sql).createSession(scope,{courseId,skillLabel:"fractions",sourceIds:[sourceId]}))
      .rejects.toMatchObject({code:"VALIDATION"});
    expect(writes).toEqual([]);
  });
  it("requires an owned course for reads",async()=>{
    const {sql}=db((query,values)=>{
      expect(query).toContain("w.owner_user_id");
      expect(values).toEqual([courseId,workspaceId,ownerUserId]);
      return [];
    });
    await expect(createOpeningLearningRepository(sql).assertOwnedCourse(scope,courseId)).rejects.toMatchObject({code:"NOT_FOUND"});
  });
  it("rejects unsupported observation revisions before a write",async()=>{
    const {sql,writes}=db(()=>[]);
    await expect(createOpeningLearningRepository(sql).insertObservation(scope,{
      sessionId:sourceId,courseId,skillLabel:"fractions",sourceIds:[],answer:"1",outcome:"unverified",assistance:"unknown",
      clientKey:"observation-key",revisesObservationId:sourceId,
    })).rejects.toMatchObject({code:"CONFLICT"});
    expect(writes).toEqual([]);
  });
});
// Replay/conflict and same-session help separation run against real SQL in opening-learning(-attempts).test.ts.
