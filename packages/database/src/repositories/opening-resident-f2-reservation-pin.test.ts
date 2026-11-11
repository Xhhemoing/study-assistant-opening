import {describe,expect,it,vi,beforeEach} from 'vitest';
import type {CourseRequirement,OpeningMaterialPurposePin} from '@aistudy/contracts';
import type {Sql,TransactionSql} from 'postgres';
import {assertCourseReservedStartPin} from './opening-course-route-reserved-start';
const port=vi.hoisted(()=>({assert:vi.fn()}));
vi.mock('./opening-course-ready-sources',()=>({createOpeningCourseReadySourcesRepository:()=>({assertMaterialPurposePin:port.assert})}));
const id=(n:number)=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const scope={workspaceId:id(1),ownerUserId:id(2)},courseId=id(3),sourceId=id(4),sourceB=id(5);
const requirement={courseId,sourceRefs:[{sourceId,sourceVersion:1},{sourceId:sourceB,sourceVersion:2}]} as CourseRequirement;
const pin:OpeningMaterialPurposePin={courseId,materialUse:'practice',sources:[
 {sourceId,sourceVersion:1,membershipId:id(6),purposeRevision:'rev-1',purpose:'practice'},
 {sourceId:sourceB,sourceVersion:2,membershipId:id(7),purposeRevision:'rev-2',purpose:'teaching'}]};
const receipt={taskId:id(8),taskVersion:2,purposePin:pin};
const sql={} as Sql,tx={} as TransactionSql;
beforeEach(()=>{vi.clearAllMocks();port.assert.mockResolvedValue(undefined);});
describe('F-resident-2: persisted reservation pin trust boundary',()=>{
 it('valid original pin is passed unchanged to real authority with supplied scope and transaction',async()=>{
  expect(await assertCourseReservedStartPin(sql,tx,scope,receipt,requirement)).toEqual(receipt);
  expect(port.assert).toHaveBeenCalledOnce();expect(port.assert).toHaveBeenCalledWith(scope,pin,tx);
 });
 it.each([
  ['null',null],['missing',undefined],['scalar','pin'],['array',[]],['empty object',{}],
  ['unknown receipt authority',{...receipt,eligible:true}],['unknown pin authority',{...receipt,purposePin:{...pin,complete:true}}],
  ['invalid task identity',{...receipt,taskId:'invalid'}],['zero task version',{...receipt,taskVersion:0}],
  ['fractional task version',{...receipt,taskVersion:1.5}],['wrong use',{...receipt,purposePin:{...pin,materialUse:'teaching'}}],
  ['empty source list',{...receipt,purposePin:{...pin,sources:[]}}],
  ['unknown source property',{...receipt,purposePin:{...pin,sources:[{...pin.sources[0],eligible:true}]}}],
  ['missing revision',{...receipt,purposePin:{...pin,sources:[{...pin.sources[0],purposeRevision:''}]}}],
  ['unsupported purpose',{...receipt,purposePin:{...pin,sources:[{...pin.sources[0],purpose:'other'}]}}],
 ])('%s is rejected before calling material authority',async(_name,raw)=>{
  await expect(assertCourseReservedStartPin(sql,tx,scope,raw,requirement)).rejects.toMatchObject({code:'CONFLICT'});
  expect(port.assert).not.toHaveBeenCalled();
 });
 it.each([
  ['wrong course',{...pin,courseId:id(9)}],['missing source',{...pin,sources:[pin.sources[0]!]}],
  ['extra source',{...pin,sources:[...pin.sources,{...pin.sources[0]!,sourceId:id(10)}]}],
  ['replacement first source same version and count',{...pin,sources:[{...pin.sources[0]!,sourceId:id(11)},pin.sources[1]!]}],
  ['replacement second source same version and count',{...pin,sources:[pin.sources[0]!,{...pin.sources[1]!,sourceId:id(12)}]}],
  ['stale first version',{...pin,sources:[{...pin.sources[0]!,sourceVersion:2},pin.sources[1]!]}],
  ['stale second version',{...pin,sources:[pin.sources[0]!,{...pin.sources[1]!,sourceVersion:1}]}],
  ['duplicate source replacing second',{...pin,sources:[pin.sources[0]!,pin.sources[0]!]}],
 ])('%s cannot recapture or authorize a changed source snapshot',async(_name,changed)=>{
  await expect(assertCourseReservedStartPin(sql,tx,scope,{...receipt,purposePin:changed},requirement)).rejects.toMatchObject({code:'CONFLICT'});
  expect(port.assert).not.toHaveBeenCalled();
 });
 it('source order is not a snapshot change when both original identities and versions remain',async()=>{
  const reordered={...receipt,purposePin:{...pin,sources:[...pin.sources].reverse()}};
  expect(await assertCourseReservedStartPin(sql,tx,scope,reordered,requirement)).toEqual(reordered);
  expect(port.assert).toHaveBeenCalledOnce();
 });
 it.each(['stale membership','purpose revision changed','privacy exclusion','wrong authenticated owner'])('%s failure propagates from authoritative material pin owner',async message=>{
  const error=Object.assign(new Error(message),{code:'CONFLICT'});port.assert.mockRejectedValueOnce(error);
  await expect(assertCourseReservedStartPin(sql,tx,scope,receipt,requirement)).rejects.toBe(error);
  expect(port.assert).toHaveBeenCalledOnce();
 });
});
