import { describe, expect, it } from "vitest";
import { DEFAULT_OPENING_AI_SETTINGS, type OpeningModelSummary } from "@aistudy/contracts";
import { openingModelSnapshot, resolveFallbackModelForTask, resolveModelForTask, resolveOpeningModel } from "./model-routing";
const first: OpeningModelSummary = { id: "one", providerId: "a", providerLabel: "A", label: "Large Name", modelName: "model-1", availability: "available", inputCentsPerMillion: 10, outputCentsPerMillion: 20 };
const second: OpeningModelSummary = { ...first, id: "two", providerId: "b", modelName: "model-2" };
describe("explicit model routing", () => {
  it("manual selection ignores automatic mappings", () => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, mode: "manual" as const, manualModelId: "two", routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "one" } };
    expect(resolveOpeningModel([first, second], settings, "explain", "one")).toBe(second);
  });
  it("automatic uses explicit mode override, workspace default, then server default", () => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "one", routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "two" } };
    expect(resolveOpeningModel([first, second], settings, "explain", "one")).toBe(second);
    expect(resolveOpeningModel([first, second], settings, "hint", "two")).toBe(first);
    expect(resolveOpeningModel([first, second], DEFAULT_OPENING_AI_SETTINGS, "hint", "two")).toBe(second);
  });
  it("never falls back when the explicit route disappears or becomes unavailable", () => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "one", routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "two" } };
    expect(() => resolveOpeningModel([first], settings, "explain", "one")).toThrow(/重新选择/);
    expect(() => resolveOpeningModel([first, { ...second, availability: "missing_key" }], settings, "explain", "one")).toThrow(/不会自动切换供应商/);
    expect(() => resolveOpeningModel([first], { ...DEFAULT_OPENING_AI_SETTINGS, mode: "manual" }, "explain", "one")).toThrow();
  });
  it("does not fall back from a removed or unavailable manual lock to automatic defaults", () => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, mode: "manual" as const, manualModelId: "two", defaultModelId: "one" };
    expect(() => resolveOpeningModel([first], settings, "explain", "one")).toThrow(/重新选择/);
    expect(() => resolveOpeningModel([first, { ...second, availability: "missing_key" }], settings, "explain", "one")).toThrow(/不会自动切换供应商/);
  });
  it("routes tutor tasks by mode and non-tutor tasks by default, never borrowing a tutor mode route", () => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "one", routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "two" } };
    expect(resolveModelForTask([first, second], settings, "tutor.explain", "one")).toBe(second);
    expect(resolveModelForTask([first, second], settings, "knowledge.extract", "two")).toBe(first);
    expect(resolveModelForTask([first, second], DEFAULT_OPENING_AI_SETTINGS, "knowledge.extract", "two")).toBe(second);
    const manual = { ...settings, mode: "manual" as const, manualModelId: "two" };
    expect(resolveModelForTask([first, second], manual, "knowledge.extract", "one")).toBe(second);
    expect(() => resolveModelForTask([first, { ...second, availability: "missing_key" }], manual, "knowledge.extract", "one")).toThrow(/不会自动切换供应商/);
  });
  it("task routes override mode routes; the manual lock overrides task routes; fallbacks are explicit", () => {
    const settings = { ...DEFAULT_OPENING_AI_SETTINGS, defaultModelId: "one", routes: { ...DEFAULT_OPENING_AI_SETTINGS.routes, explain: "one" },
      taskRoutes: { "tutor.explain": { primary: "two", fallback: null }, "knowledge.extract": { primary: null, fallback: "two" } } };
    expect(resolveModelForTask([first, second], settings, "tutor.explain", "one")).toBe(second);
    expect(resolveModelForTask([first, second], settings, "knowledge.extract", "one")).toBe(first);
    expect(resolveFallbackModelForTask([first, second], settings, "knowledge.extract")).toBe(second);
    expect(resolveFallbackModelForTask([first, second], settings, "tutor.explain")).toBeNull();
    expect(resolveFallbackModelForTask([first, { ...second, availability: "missing_key" }], settings, "knowledge.extract")).toBeNull();
    expect(resolveModelForTask([first, second], { ...settings, mode: "manual" as const, manualModelId: "one" }, "tutor.explain", "two")).toBe(first);
  });
  it("snapshots only routing identity and actual configured rates", () => {
    expect(openingModelSnapshot({ ...second, apiKey: "private" } as never)).toEqual({ id: "two", providerId: "b", modelName: "model-2", inputCentsPerMillion: 10, outputCentsPerMillion: 20 });
  });
});

describe("Luna visual defaults",()=>{
 const luna:OpeningModelSummary={...first,id:"luna",modelName:"gpt-6-luna",supportsVision:true};
 it.each(["materials.recognize-page","practice.recognize-photo","practice.grade-photo","teaching.compile-visual"] as const)("selects configured Luna for %s without borrowing a text default",task=>{
  expect(resolveModelForTask([first,luna],{...DEFAULT_OPENING_AI_SETTINGS,defaultModelId:"one"},task,"one")).toBe(luna);
 });
 it("preserves explicit task routes and manual locks, including their capability failures",()=>{
  const visualOther={...first,supportsVision:true},settings={...DEFAULT_OPENING_AI_SETTINGS,taskRoutes:{"materials.recognize-page":{primary:"one",fallback:null}}};
  expect(resolveModelForTask([visualOther,luna],settings,"materials.recognize-page","luna")).toBe(visualOther);
  expect(resolveModelForTask([visualOther,luna],{...settings,mode:"manual",manualModelId:"one"},"materials.recognize-page","luna")).toBe(visualOther);
  expect(()=>resolveModelForTask([first,luna],settings,"materials.recognize-page","luna")).toThrow(/图片输入/);
 });
 it("requires the exact configured model and keeps its unavailable or missing-vision failure explicit",()=>{
  expect(()=>resolveModelForTask([first,{...luna,modelName:"alias-gpt-6-luna"}],DEFAULT_OPENING_AI_SETTINGS,"materials.recognize-page","one")).toThrow(/gpt-6-luna/);
  expect(()=>resolveModelForTask([first,{...luna,supportsVision:false}],DEFAULT_OPENING_AI_SETTINGS,"materials.recognize-page","one")).toThrow(/图片输入/);
  expect(()=>resolveModelForTask([first,{...luna,availability:"missing_key"}],DEFAULT_OPENING_AI_SETTINGS,"materials.recognize-page","one")).toThrow(/不会自动切换/);
 });
 it("does not silently choose between Luna providers or switch away from a preferred unavailable provider",()=>{
  const other={...luna,id:"luna-other",providerId:"another"};
  expect(()=>resolveModelForTask([first,luna,other],DEFAULT_OPENING_AI_SETTINGS,"materials.recognize-page","one")).toThrow(/多个/);
  expect(resolveModelForTask([luna,other],{...DEFAULT_OPENING_AI_SETTINGS,defaultModelId:"luna-other"},"materials.recognize-page","luna")).toBe(other);
  expect(()=>resolveModelForTask([{...luna,availability:"missing_key"},other],{...DEFAULT_OPENING_AI_SETTINGS,defaultModelId:"luna"},"materials.recognize-page","luna-other")).toThrow(/不会自动切换/);
 });
});
