// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot,type Root } from "react-dom/client";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import type { AnswerInterpretationCorrection,AnswerInterpretationSnapshot } from "@aistudy/contracts";
import { AnswerInterpretationControl } from "./answer-interpretation-control";
import { OpeningApiError } from "../client/api";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";
let clearIdentity:()=>void;
const id="00000000-0000-4000-8000-000000000001",head="00000000-0000-4000-8000-000000000002";
const snapshot:AnswerInterpretationSnapshot={rootObservationId:id,headObservationId:head,originalAnswer:"证明见原图",workSource:{id,version:3,physicalPage:2},
  originalTranscriptionObservationId:head,originalTranscription:"A²v=λv",currentInterpretation:null,versions:[],canCorrect:true,reason:null};
let root:Root,container:HTMLDivElement;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});sessionStorage.clear();clearIdentity=publishVerifiedSessionIdentity({id,workspaceId:head});container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();clearIdentity();});
function api(){return {read:vi.fn(async(_id:string)=>snapshot),correct:vi.fn(async(_id:string,_input:AnswerInterpretationCorrection)=>({snapshot,observation:learningObservation,replayed:false}))};}
async function click(text:string){const button=Array.from(container.querySelectorAll("button")).find(row=>row.textContent===text);expect(button).toBeTruthy();await act(async()=>button!.click());}
async function fill(){const textarea=container.querySelector("textarea")!,input=container.querySelector("input")!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"A²v=λ²v");textarea.dispatchEvent(new Event("input",{bubbles:true}));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"漏了平方");input.dispatchEvent(new Event("input",{bubbles:true}));});}
it("opens the original captured photo and transcription without saving or grading on render",async()=>{
  const client=api();await act(async()=>root.render(createElement(AnswerInterpretationControl,{observationId:head,onUpdated(){},api:client})));
  expect(client.read).not.toHaveBeenCalled();expect(client.correct).not.toHaveBeenCalled();
  await click("核对照片与转写");expect(container.textContent).toContain("原识别：A²v=λv");expect(container.textContent).toContain("版本3");
  expect(container.textContent).toContain("保存不会调用模型");expect(client.correct).not.toHaveBeenCalled();
});
it("freezes one unknown save request and retries its exact head, key and transcription",async()=>{
  const client=api(),onUpdated=vi.fn();client.correct.mockRejectedValueOnce(new Error("network outcome unknown"));
  await act(async()=>root.render(createElement(AnswerInterpretationControl,{observationId:head,onUpdated,api:client})));
  await click("核对照片与转写");await fill();await click("保存校正版（不重新批改）");
  expect(container.querySelector("textarea")!.disabled).toBe(true);expect(onUpdated).not.toHaveBeenCalled();
  await click("确认同一次校正保存结果");expect(client.correct.mock.calls[0]).toEqual(client.correct.mock.calls[1]);
  expect(client.correct.mock.calls[0]![1]).toMatchObject({expectedHead:head,correctedTranscription:"A²v=λ²v",reason:"漏了平方"});expect(onUpdated).toHaveBeenCalledOnce();
});
it("reloads a conflicting head while preserving correction text instead of silently resubmitting",async()=>{
  const client=api();client.correct.mockRejectedValueOnce(new OpeningApiError(409,"head changed","CONFLICT"));
  await act(async()=>root.render(createElement(AnswerInterpretationControl,{observationId:head,onUpdated(){},api:client})));
  await click("核对照片与转写");await fill();await click("保存校正版（不重新批改）");
  client.read.mockResolvedValue({...snapshot,headObservationId:id});await click("重新读取当前版本并保留输入");
  expect(container.querySelector("textarea")!.value).toBe("A²v=λ²v");expect(client.correct).toHaveBeenCalledOnce();
  await click("保存校正版（不重新批改）");expect(client.correct.mock.calls[1]![1].expectedHead).toBe(id);
});
it("persists before send and restores a deferred unknown request across remount without a new key",async()=>{
  const client=api();let reject!:(error:Error)=>void;
  client.correct.mockImplementationOnce(()=>new Promise((_yes,no)=>{reject=no;}));
  const render=()=>act(async()=>root.render(createElement(AnswerInterpretationControl,{observationId:head,onUpdated(){},api:client})));
  await render();await click("核对照片与转写");await fill();await click("保存校正版（不重新批改）");
  const first=client.correct.mock.calls[0]![1];expect(sessionStorage.length).toBe(1);
  await act(async()=>root.render(null));await act(async()=>reject(new Error("unknown")));await render();await click("核对照片与转写");
  expect(container.querySelector("textarea")!.value).toBe(first.correctedTranscription);expect(container.querySelector("textarea")!.disabled).toBe(true);
  client.correct.mockRejectedValueOnce(new OpeningApiError(409,"replay state unavailable","CONFLICT"));await click("确认同一次校正保存结果");
  expect(container.querySelector("textarea")!.disabled).toBe(true);await click("确认同一次校正保存结果");
  expect(client.correct.mock.calls[1]![1]).toEqual(first);expect(client.correct.mock.calls[2]![1]).toEqual(first);
});
it("does not restore another verified account's pending photo text",async()=>{
  const client=api();client.correct.mockRejectedValueOnce(new Error("unknown"));
  await act(async()=>root.render(createElement(AnswerInterpretationControl,{observationId:head,onUpdated(){},api:client})));
  await click("核对照片与转写");await fill();await click("保存校正版（不重新批改）");await act(async()=>root.render(null));
  const clearOther=publishVerifiedSessionIdentity({id:head,workspaceId:id});
  await act(async()=>root.render(createElement(AnswerInterpretationControl,{observationId:head,onUpdated(){},api:client})));
  await click("核对照片与转写");expect(container.querySelector("textarea")!.value).toBe(snapshot.originalTranscription);expect(container.querySelector("input")!.value).toBe("");clearOther();
});
it("only releases an unknown old CAS when an explicit root-scoped read proves the head advanced, preserving text",async()=>{
  const client=api();client.correct.mockRejectedValueOnce(new Error("unknown"));
  await act(async()=>root.render(createElement(AnswerInterpretationControl,{observationId:head,onUpdated(){},api:client})));
  await click("核对照片与转写");await fill();await click("保存校正版（不重新批改）");const original=client.correct.mock.calls[0]![1];
  await click("重新读取当前作答版本");expect(container.querySelector("textarea")!.disabled).toBe(true);
  client.read.mockResolvedValue({...snapshot,headObservationId:id});await click("重新读取当前作答版本");
  expect(container.querySelector("textarea")!.value).toBe(original.correctedTranscription);expect(container.querySelector("textarea")!.disabled).toBe(false);
  expect(container.textContent).toContain("不表示刚才的保存一定成功");await click("保存校正版（不重新批改）");
  expect(client.correct.mock.calls[1]![1].expectedHead).toBe(id);expect(client.correct.mock.calls[1]![1].clientKey).not.toBe(original.clientKey);
});
