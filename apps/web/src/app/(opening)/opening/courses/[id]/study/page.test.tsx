import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({context:vi.fn(),span:vi.fn(),redirect:vi.fn(),headers:vi.fn()}));
vi.mock('next/headers',()=>({headers:mocks.headers}));
vi.mock('next/navigation',()=>({redirect:mocks.redirect,notFound:()=>{throw new Error('not found');}}));
vi.mock('@aistudy/ai',()=>({isTeachingCompilerEnabled:()=>true}));
vi.mock('../../../../../../features/opening/courses/server/course-study-context',()=>({loadCourseStudyContext:mocks.context}));
vi.mock('../../../../../../features/opening/courses/server/course-span-resume',()=>({loadCourseSpanResume:mocks.span}));
vi.mock('../../../../../../features/opening/courses/course-study-workspace',()=>({CourseStudyWorkspace:()=>null}));
import CourseStudyPage from './page';
const course='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',activity='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',task='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
beforeEach(()=>{vi.clearAllMocks();mocks.headers.mockResolvedValue(new Headers());mocks.context.mockResolvedValue({teachingEnabled:true,sourceIds:[],timeZone:'UTC'});mocks.span.mockResolvedValue({courseId:course,activityId:activity});mocks.redirect.mockImplementation(()=>{throw new Error('REDIRECT');});});
it('actual page dispatch preserves combined task/activity for admission instead of protocol-redirecting first',async()=>{
 const page=await CourseStudyPage({params:Promise.resolve({id:course}),searchParams:Promise.resolve({task,activity})});
 expect(mocks.span).not.toHaveBeenCalled();expect(mocks.redirect).not.toHaveBeenCalled();
 expect(page.props).toMatchObject({courseId:course,activityId:activity,taskId:task});
});
it('standalone valid span activity retains protocol redirection',async()=>{
 await expect(CourseStudyPage({params:Promise.resolve({id:course}),searchParams:Promise.resolve({activity})})).rejects.toThrow('REDIRECT');
 expect(mocks.span).toHaveBeenCalledTimes(1);expect(mocks.redirect).toHaveBeenCalledWith(`/opening/courses/${course}/study/span?lesson=${activity}`);
});
it('malformed or conflicting navigation cannot redirect past validation',async()=>{
 for(const query of [{task:'',activity},{task:'invalid',activity},{activity,after:task}]){
  const page=await CourseStudyPage({params:Promise.resolve({id:course}),searchParams:Promise.resolve(query)});
  expect(page.props.practiceEntryError).toBeTruthy();
 }
 expect(mocks.span).not.toHaveBeenCalled();expect(mocks.redirect).not.toHaveBeenCalled();
});
it('changing task with the same activity remounts the page workspace identity',async()=>{
 const a=await CourseStudyPage({params:Promise.resolve({id:course}),searchParams:Promise.resolve({activity,task})});
 const b=await CourseStudyPage({params:Promise.resolve({id:course}),searchParams:Promise.resolve({activity,task:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'})});
 expect(a.key).not.toBe(b.key);
});
