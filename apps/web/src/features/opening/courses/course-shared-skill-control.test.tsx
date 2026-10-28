// @vitest-environment jsdom
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { beforeEach,afterEach,it,expect,vi } from "vitest";
import { CourseSharedSkillControl,type CourseSharedSkillClient } from "./course-shared-skill-control";
const a="11111111-1111-4111-8111-111111111111",b="22222222-2222-4222-8222-222222222222",course="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const req=(id:string)=>({id,courseId:id===a?a:course,stableSkillId:id,knowledgeNodeId:null,requirementKey:id,title:id===a?"课程A秩":"课程B秩",position:0,mandatory:true,goalIds:[],prerequisiteIds:[],sourceRefs:[],verification:{kind:"rubric" as const,status:"ready" as const,exerciseKeys:[],rubric:"说明理由",missingReasons:[]},revision:1,lifecycle:"active" as const,origin:"confirmed" as const,approvedAt:"2026-10-27T00:00:00Z",evidenceConditions:{responseFormat:"text" as const,timeLimitSeconds:null,assistance:"independent" as const}});
const view={courseId:course,requirements:[{requirement:req(b),courseTitle:"课程B",goals:[{id:b,title:"目标B"}]}],candidates:[{requirement:req(a),courseTitle:"课程A",goals:[{id:a,title:"目标A"}]}],links:[]};
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);sessionStorage.clear();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const button=(text:string)=>[...host.querySelectorAll("button")].find(row=>row.textContent===text)!;
it("requires explicit side-by-side compatibility confirmation before linking real requirements",async()=>{
 const client={read:vi.fn(async()=>view),command:vi.fn(async()=>view)};
 await act(async()=>root.render(<CourseSharedSkillControl courseId={course} client={client}/>));expect(client.read).not.toHaveBeenCalled();
 await act(async()=>button("核对跨课程技能复用").click());expect(host.textContent).toContain("课程A");expect(host.textContent).toContain("说明理由");expect(client.command).not.toHaveBeenCalled();
 expect(button("确认映射并复用有效证据").disabled).toBe(true);await act(async()=>(host.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
 await act(async()=>button("确认映射并复用有效证据").click());expect(client.command).toHaveBeenCalledWith(course,expect.objectContaining({action:"link",sourceRequirementId:a,targetRequirementId:b,expectedSourceRevision:1,expectedTargetRevision:1,confirmed:true}));
});
it("restores an unknown original mapping command across remount without generating another intent",async()=>{
 const client={read:vi.fn(async()=>view),command:vi.fn().mockRejectedValue(new TypeError("lost"))} as CourseSharedSkillClient;
 await act(async()=>root.render(<CourseSharedSkillControl courseId={course} client={client}/>));await act(async()=>button("核对跨课程技能复用").click());await act(async()=>(host.querySelector('input[type="checkbox"]') as HTMLInputElement).click());await act(async()=>button("确认映射并复用有效证据").click());
 const original=vi.mocked(client.command).mock.calls[0];await act(async()=>root.unmount());root=createRoot(host);await act(async()=>root.render(<CourseSharedSkillControl courseId={course} client={client}/>));await act(async()=>button("重新确认原映射操作").click());expect(vi.mocked(client.command).mock.calls[1]).toEqual(original);
});
it("retains a timed-out mapping through its HTTP client and a rejected retry",async()=>{
 const responses=[408,409,200];
 const transport=vi.fn<typeof fetch>(async(_input,init)=>init?.method==="POST"?Response.json(responses[0]===200?view:{error:{message:"请求尚未确认"}},{status:responses.shift()!}):Response.json(view));
 vi.stubGlobal("fetch",transport);
 await act(async()=>root.render(<CourseSharedSkillControl courseId={course}/>));
 await act(async()=>button("核对跨课程技能复用").click());
 await act(async()=>(host.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
 await act(async()=>button("确认映射并复用有效证据").click());
 expect(host.textContent).toContain("映射保存结果待确认");
 await act(async()=>root.unmount());root=createRoot(host);
 await act(async()=>root.render(<CourseSharedSkillControl courseId={course}/>));
 await act(async()=>button("重新确认原映射操作").click());
 expect(host.textContent).toContain("映射保存结果待确认");
 await act(async()=>button("重新确认原映射操作").click());
 const posts=transport.mock.calls.filter(([,init])=>init?.method==="POST");
 expect(posts).toHaveLength(3);expect(posts.map(([,init])=>init!.body)).toEqual([posts[0]![1]!.body,posts[0]![1]!.body,posts[0]![1]!.body]);
 expect(host.textContent).toContain("映射已保存");
});
