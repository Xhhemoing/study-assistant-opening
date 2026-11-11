import {beforeEach,describe,expect,it,vi} from 'vitest';
import {generateOpeningStudyExposure,releaseOpeningStudyExposure,type OpeningStudyExposureInput} from './opening-study-exposure';
import {sqlSimulation,unexpected,type Query} from './opening-resident-f10-sql-simulation';
const ports=vi.hoisted(()=>({invalidate:vi.fn()}));
vi.mock('./opening-learning-eligibility',()=>({invalidateOpeningLearningEligibility:ports.invalidate}));
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const scope={workspaceId:id(1),ownerUserId:id(2)},courseId=id(3),sourceId=id(4),chunkId=id(6);
const at='2026-01-02T00:00:00.000Z';
function parseInsert(q:Query){
 const m=/INSERT INTO opening_help_exposures\(([^)]+)\) VALUES\((.*)\) RETURNING \*/.exec(q.text);if(!m)throw new Error('selected insert not recognized');
 let i=0;const expressions=m[2]!.split(',');return Object.fromEntries(m[1]!.split(',').map((key,n)=>{const s=expressions[n]!.trim();return [key.trim(),s==='?'?q.values[i++]:s==='FALSE'?false:s==='0'?0:at]}));
}
function fixture(){
 const state={version:1,historical:true,readable:true,excluded:false,ready:true,purpose:'teaching' as string|null,stored:null as Record<string,unknown>|null};
 const writes:string[]=[];
 const f=sqlSimulation(q=>{
  const s=q.text;
  if(s.startsWith('SELECT * FROM opening_help_exposures'))return state.stored?[state.stored]:[];
  if(s.startsWith('SELECT id FROM workspaces'))return [{id:scope.workspaceId}];
  if(s.startsWith('SELECT id FROM courses'))return [{id:courseId}];
  if(s.startsWith('SELECT id,version FROM opening_sources')){
   const human=q.values.includes(true);return (state.ready||human)&&(!state.excluded||human)?[{id:sourceId,version:state.version}]:[];
  }
  if(s.startsWith('SELECT version FROM opening_source_versions'))return state.historical?[{version:1}]:[];
  if(s.startsWith('SELECT source_id,source_version,page FROM opening_source_chunks'))return [{source_id:sourceId,source_version:1,page:1}];
  if(s.startsWith('SELECT id FROM opening_source_chunks'))return state.readable?[{id:chunkId}]:[];
  if(s.startsWith('SELECT id FROM course_asset_memberships'))return [{id:id(7)}];
  if(s.startsWith('SELECT asset_id,purpose FROM course_asset_memberships'))return [{asset_id:sourceId,purpose:state.purpose}];
  if(s.startsWith('INSERT INTO opening_help_exposures')){state.stored={...parseInsert(q),acknowledged_at:null};return [state.stored]}
  if(s.startsWith('INSERT INTO opening_learning_history_revisions')){writes.push('course-revision');return [{revision:2}]}
  if(s.startsWith('UPDATE opening_workspace_history_revisions')){writes.push('workspace-revision');return [{revision:3}]}
  if(s.startsWith('UPDATE opening_help_exposures')){writes.push('release');state.stored={...state.stored,released_at:at,history_revision:2};return [state.stored]}
  if(s.startsWith('SELECT DISTINCT COALESCE'))return [];
  return unexpected(q);
 });
 const input:OpeningStudyExposureInput={releaseKey:'f10:context',contextAnchor:{purpose:'learning_help',courseId,sourceId,sourceVersion:1,chunkId,page:1},origin:'assistant',kind:'hint',level:'hinted'};
 return {...f,state,writes,input,generate:(patch:Partial<OpeningStudyExposureInput>={})=>generateOpeningStudyExposure(f.sql,scope,{...input,...patch}),release:()=>releaseOpeningStudyExposure(f.sql,scope,String(state.stored!.id))};
}
beforeEach(()=>{vi.clearAllMocks();ports.invalidate.mockResolvedValue(undefined)});
describe('F10: real exposure release resolves the original material context again',()=>{
 it('unmodified assistant context releases through actual resolver and retains pinned version',async()=>{
  const f=fixture();const generated=await f.generate();expect(generated.contextAnchor).toMatchObject({sourceId,sourceVersion:1,page:1});
  expect(generated.releasedAt).toBeNull();expect(f.writes).toEqual([]);const result=await f.release();expect(result.contextAnchor).toEqual(generated.contextAnchor);
  expect(result.releasedAt).toBe(at);expect(f.writes).toEqual(['course-revision','workspace-revision','release']);expect(ports.invalidate).toHaveBeenCalledOnce();
 });
 it.each([
  ['AI exclusion', (f:ReturnType<typeof fixture>)=>{f.state.excluded=true}],
  ['parse no longer ready',(f:ReturnType<typeof fixture>)=>{f.state.ready=false}],
  ['purpose becomes reference',(f:ReturnType<typeof fixture>)=>{f.state.purpose='reference'}],
  ['purpose becomes mock exam',(f:ReturnType<typeof fixture>)=>{f.state.purpose='mock_exam'}],
  ['selected page disappears',(f:ReturnType<typeof fixture>)=>{f.state.readable=false}],
  ['old version unavailable',(f:ReturnType<typeof fixture>)=>{f.state.version=2;f.state.historical=false}],
 ])('%s between generation and release rejects without history or release writes',async(_name,change)=>{
  const f=fixture();await f.generate();const original=structuredClone(f.state.stored);change(f);
  await expect(f.release()).rejects.toMatchObject({code:'CONFLICT'});expect(f.writes).toEqual([]);expect(f.state.stored).toEqual(original);expect(ports.invalidate).not.toHaveBeenCalled();
 });
 it('available historic version stays pinned instead of rebinding to newest material',async()=>{
  const f=fixture();await f.generate();f.state.version=2;const result=await f.release();expect(result.contextAnchor.sourceVersion).toBe(1);
  expect(f.queries.some(q=>q.text.startsWith('SELECT version FROM opening_source_versions')&&q.values.includes(1))).toBe(true);
 });
 it('human excerpt release remains human reading despite AI exclusion and reference purpose',async()=>{
  const f=fixture();await f.generate({origin:'material_excerpt',contextAnchor:{...f.input.contextAnchor,purpose:'material_read'}});f.state.excluded=true;f.state.ready=false;f.state.purpose='reference';
  await expect(f.release()).resolves.toMatchObject({releasedAt:at});
  expect(f.queries.filter(q=>q.text.startsWith('SELECT asset_id,purpose'))).toHaveLength(0);
 });
 it('material-read assistant uses citation purpose while learning help requires teaching',async()=>{
  const f=fixture();f.state.purpose='reference';await expect(f.generate()).rejects.toMatchObject({code:'CONFLICT'});expect(f.state.stored).toBeNull();
  await f.generate({contextAnchor:{...f.input.contextAnchor,purpose:'material_read'}});await expect(f.release()).resolves.toMatchObject({releasedAt:at});
 });
});
