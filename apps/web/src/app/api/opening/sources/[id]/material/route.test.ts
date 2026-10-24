import {beforeEach,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({scope:vi.fn(),read:vi.fn(),write:vi.fn(),reveal:vi.fn()}));
vi.mock("../../../../../../features/opening/runtime",()=>({requireOpeningScope:mocks.scope}));
vi.mock("../../../../../../features/opening/server/material-services",()=>({materialManifestService:()=>({read:mocks.read,write:mocks.write,revealForEditing:mocks.reveal})}));
vi.mock("../../../../../../features/auth/service",()=>({mapDomainError:(e:unknown)=>e,jsonError:(e:{status?:number;message?:string})=>Response.json({message:e.message??'invalid'},{status:e.status??400})}));
import {GET,POST,PUT} from "./route";
const scope={workspaceId:'w',ownerUserId:'u'},id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const context={params:Promise.resolve({id})};
beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockResolvedValue({scope,sql:{}});mocks.read.mockResolvedValue({manifest:{answers:[]},answersWithheld:true,answerCount:1});mocks.write.mockResolvedValue({revision:2,manifest:{answers:[]}});mocks.reveal.mockResolvedValue({manifest:{answers:[{text:'explicit answer'}]}});});
it('GET uses metadata-only reader, ignores attempted reveal via query and never calls the reveal writer',async()=>{
 const r=await GET(new Request('http://test/material?reveal=true&ownerUserId=foreign'),context);
 expect(r.status).toBe(200);expect(await r.json()).toMatchObject({manifest:{answers:[]}});
 expect(mocks.read).toHaveBeenCalledExactlyOnceWith(scope,id);expect(mocks.reveal).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();
 expect(r.headers.get('cache-control')).toBe('no-store');
});
it('POST requires an explicit reveal action and calls the exposure-backed service with the authenticated scope',async()=>{
 const r=await POST(new Request('http://test/material',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'reveal_answers'})}),context);
 expect(r.status).toBe(200);expect(await r.json()).toMatchObject({manifest:{answers:[{text:'explicit answer'}]}});
 expect(mocks.reveal).toHaveBeenCalledExactlyOnceWith(scope,id);expect(mocks.read).not.toHaveBeenCalled();
 const invalid=await POST(new Request('http://test/material',{method:'POST',body:JSON.stringify({action:'reveal_answers',ownerUserId:'foreign'})}),context);
 expect(invalid.status).toBe(400);expect(mocks.reveal).toHaveBeenCalledTimes(1);
});
it('rejected authentication prevents both disclosure and editing',async()=>{
 mocks.scope.mockRejectedValue({status:401,message:'login required'});
 for(const method of [GET,POST,PUT]) expect((await method(new Request('http://test/material',{method:'POST',body:'{}'}),context)).status).toBe(401);
 expect(mocks.read).not.toHaveBeenCalled();expect(mocks.write).not.toHaveBeenCalled();expect(mocks.reveal).not.toHaveBeenCalled();
});
