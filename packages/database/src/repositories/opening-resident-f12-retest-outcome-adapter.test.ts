import {describe,expect,it} from 'vitest';
import type {CourseRouteObservation} from '@aistudy/domain';
import {readOpeningCourseRouteRetestOutcome} from './opening-course-route-retest-state';
import {sqlSimulation,unexpected} from './opening-resident-f12-sql-simulation';
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const scope={workspaceId:id(1),ownerUserId:id(2)},retestId=id(3),courseId=id(4),requirementId=id(5),skillId=id(6);
const protocol={protocolId:'course-route-delayed-v1',goalId:id(7),goalRevision:1,requirementId,requirementRevision:2,stableSkillId:skillId,baselineObservationId:id(8),baselineRootId:id(8),originActivityId:id(9),minutes:20};
const observation:CourseRouteObservation={id:id(10),skillLabel:'Arithmetic',requirementKey:'arithmetic',attemptedAt:'2026-01-02T00:00:00.000Z',assistance:'independent',verifiedCorrect:'yes',independentAttempt:'yes',usableForCurrentVersion:'yes',problemId:id(11),firstQuestionExposure:true,courseRequirement:{id:requirementId,revision:2,stableSkillId:skillId,requirementKey:'arithmetic'}};
function fixture(options:{missing?:boolean;status?:string;protocol?:unknown;record?:Record<string,unknown>|null;interval?:Record<string,unknown>|null;errorAt?:'record'|'interval'}={}){
 const failure=new Error(`synthetic ${options.errorAt} failed`);
 const f=sqlSimulation(q=>{
  if(q.text.startsWith('SELECT r.*,t.status AS task_status'))return options.missing?[]:[{course_id:courseId,requirement_key:'arithmetic',learning_protocol:options.protocol===undefined?protocol:options.protocol,status:options.status??'completed',deadline_at:'2026-01-03T00:00:00.000Z'}];
  if(q.text.startsWith('SELECT o.submitted_at,a.started_at')){
   if(options.errorAt==='record')throw failure;return options.record===null?[]:[{submitted_at:'2026-01-02T00:10:00.000Z',started_at:'2026-01-02T00:00:00.000Z',baseline_at:'2026-01-01T00:00:00.000Z',baseline_current:true,...options.record}];
  }
  if(q.text.startsWith('SELECT EXISTS(SELECT 1 FROM opening_help_exposures')){
   if(options.errorAt==='interval')throw failure;return options.interval===null?[]:[{helped:false,practiced:false,...options.interval}];
  }
  return unexpected(q);
 });return {...f,failure,read:(value:CourseRouteObservation|null=observation)=>readOpeningCourseRouteRetestOutcome(f.sql,scope,retestId,value)};
}
describe('F12: retest outcome adapter conservatively qualifies evidence before real domain outcome',()=>{
 it('current first independent correct answer passes with unchanged caller observation',async()=>{
  const f=fixture();const before=structuredClone(observation);await expect(f.read()).resolves.toBe('passed');expect(observation).toEqual(before);expect(f.queries).toHaveLength(3);
 });
 it.each([false,undefined])('first exposure %s cannot inherit yes independence',async firstQuestionExposure=>{
  const f=fixture();await expect(f.read({...observation,firstQuestionExposure})).resolves.toBe('insufficient_evidence');
 });
 it.each([
  ['baseline withdrawn',{record:{baseline_current:false}}],['baseline missing',{record:null}],['unknown baseline',{record:{baseline_current:null}}],
  ['mismatched requirement',{protocol:{...protocol,requirementId:id(20)}}],['mismatched revision',{protocol:{...protocol,requirementRevision:3}}],['mismatched stable skill',{protocol:{...protocol,stableSkillId:id(20)}}],['malformed protocol',{protocol:{...protocol,extra:true}}],
 ])('%s cannot retain current-version eligibility',async(_name,options)=>{
  const f=fixture(options);await expect(f.read()).resolves.toBe('insufficient_evidence');
 });
 it('missing observation requirement binding cannot pass',async()=>{const f=fixture();await expect(f.read({...observation,courseRequirement:undefined})).resolves.toBe('insufficient_evidence')});
 it.each([
  ['recorded interval help',{helped:true},'assisted'],['recorded interval practice',{practiced:true},'insufficient_evidence'],['both recorded',{helped:true,practiced:true},'assisted'],
 ])('%s reaches actual domain policy',async(_name,interval,expected)=>{const f=fixture({interval});await expect(f.read()).resolves.toBe(expected)});
 it.each([
  ['incorrect',{...observation,verifiedCorrect:'no' as const},'failed'],['hinted',{...observation,assistance:'hinted' as const},'assisted'],['unknown correctness',{...observation,verifiedCorrect:'unknown' as const},'insufficient_evidence'],
 ])('%s effective observation is not promoted by adapter',async(_name,value,expected)=>{const f=fixture();await expect(f.read(value)).resolves.toBe(expected)});
 it('persisted submitted time after deadline expires even completed evidence',async()=>{const f=fixture({record:{submitted_at:'2026-01-04T00:00:00.000Z'}});await expect(f.read()).resolves.toBe('expired')});
 it('null observation does not read answer/interval rows or invent completed evidence',async()=>{const f=fixture();await expect(f.read(null)).resolves.toBe('insufficient_evidence');expect(f.queries).toHaveLength(1)});
 it.each(['record','interval'] as const)('%s read failure propagates identity instead of empty-success fallback',async errorAt=>{const f=fixture({errorAt});await expect(f.read()).rejects.toBe(f.failure);expect(f.queries).toHaveLength(errorAt==='record'?2:3)});
});
