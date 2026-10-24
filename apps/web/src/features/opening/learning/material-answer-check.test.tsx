// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../assistant/learning-prose',()=>({LearningProse:({text}:{text:string})=>createElement('p',null,text)}));
import {MaterialAnswerCheck,answersSchema} from './material-answer-check';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',attempt='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const answer={page:2,sourceId:id,sourceVersion:0,questionSourceId:id,questionSourceVersion:0,question:{family:'T1',number:'1',subquestion:''},text:'z=1-i',status:'disputed',reason:'待核验横线',reviewedBy:id,reviewedAt:'2026-10-23T00:00:00.000Z'};
afterEach(()=>vi.unstubAllGlobals());
it('parses complete server answer links without rejecting locator fields and retains status validation',()=>{
 expect(answersSchema.parse([answer])[0]).toEqual(answer);
 expect(answersSchema.safeParse([{...answer,reason:''}]).success).toBe(false);
 expect(answersSchema.safeParse([{...answer,sourceVersion:-1}]).success).toBe(false);
});
it('does not fetch on mount; an explicit post-submission check renders the specific answer and dispute reason',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const fetcher=vi.fn(async()=>Response.json([answer]));vi.stubGlobal('fetch',fetcher);
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{
  await act(async()=>root.render(createElement(MaterialAnswerCheck,{attemptId:attempt})));
  expect(fetcher).not.toHaveBeenCalled();expect(host.textContent).not.toContain('z=1-i');
  await act(async()=>host.querySelector('button')!.click());
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/opening/attempts/${attempt}/answers`,{cache:'no-store'});
  expect(host.textContent).toContain('z=1-i');expect(host.textContent).toContain('不计分、不增加薄弱度');expect(host.textContent).toContain('待核验横线');
 }finally{await act(async()=>root.unmount());host.remove();}
});
