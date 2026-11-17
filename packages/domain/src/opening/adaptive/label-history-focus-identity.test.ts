import { describe, expect, it } from "vitest";
import { plannerHistoryIdentity, normalizedSuggestionIdentity, normalizeSkillLabelKey } from "./skill-identity";
import { suggestionIdentity, suggestionKey, parseSuggestionKey } from "./types";

const kind="practice",course="course-a",label="Linear Algebra";

describe("history key compatibility is not permission to borrow another skill requirement",()=>{
  it("normalizes a recoverable legacy unscoped key to current label alias without rewriting stored clientKey",()=>{
    const stored=suggestionIdentity(kind,course,"ＬＩＮＥＡＲ Algebra");
    const clientKey=suggestionKey("2026-11-10",stored);
    const parsed=parseSuggestionKey(clientKey)!;
    expect(plannerHistoryIdentity(parsed.identity,label)).toBe(normalizedSuggestionIdentity(kind,course,label));
    expect(clientKey).toBe(`planner:2026-11-10:${stored}`);
  });
  it("normalizes scoped key only when its saved requirement attribution is present",()=>{
    const stored=suggestionIdentity(kind,course,"LINEAR ALGEBRA","calculate");
    expect(plannerHistoryIdentity(stored,label,"calculate")).toBe(normalizedSuggestionIdentity(kind,course,label,"calculate"));
    expect(plannerHistoryIdentity(stored,label,null)).toBe(stored);
    expect(plannerHistoryIdentity(stored,label,undefined)).toBe(stored);
  });
  it("named requirements remain separate even when label aliases and activity kinds coincide",()=>{
    const calc=normalizedSuggestionIdentity(kind,course," ＬＩＮＥＡＲ ALGEBRA ","calculate");
    const prove=normalizedSuggestionIdentity(kind,course,label,"prove");
    expect(calc).not.toBe(prove);
    expect(plannerHistoryIdentity(calc,label,"calculate")).toBe(calc);
  });
  it("empty named requirement is not silently substituted with null legacy identity",()=>{
    const empty=normalizedSuggestionIdentity(kind,course,label,"");
    const missing=normalizedSuggestionIdentity(kind,course,label,null);
    expect(empty).not.toBe(missing);
    expect(plannerHistoryIdentity(empty,label,"")).toBe(empty);
    expect(plannerHistoryIdentity(empty,label,null)).toBe(empty);
    const originalSpelling=suggestionIdentity(kind,course,"ＬＩＮＥＡＲ ALGEBRA","");
    expect(originalSpelling).not.toBe(empty);
    expect(plannerHistoryIdentity(originalSpelling,label,"")).toBe(empty);
    expect(plannerHistoryIdentity(originalSpelling,label,null)).toBe(originalSpelling);
  });
  it("legacy key recovery may add known stored requirement but never guesses one from the label",()=>{
    const stored=suggestionIdentity(kind,course,label);
    expect(plannerHistoryIdentity(stored,label,"calculate")).toBe(normalizedSuggestionIdentity(kind,course,label,"calculate"));
    expect(plannerHistoryIdentity(stored,label)).toBe(normalizedSuggestionIdentity(kind,course,label));
  });
  it("course and suggestion kind stay part of identity after canonical recovery",()=>{
    const a=plannerHistoryIdentity(suggestionIdentity(kind,"course-a",label),label);
    const b=plannerHistoryIdentity(suggestionIdentity(kind,"course-b",label),label);
    const other=plannerHistoryIdentity(suggestionIdentity("retest","course-a",label),label);
    expect(a).not.toBe(b);expect(a).not.toBe(other);
  });
  it("null course remains null rather than the literal string none as a new course",()=>{
    const stored=suggestionIdentity(kind,null,label);
    expect(plannerHistoryIdentity(stored," ＬＩＮＥＡＲ Algebra ")).toBe(normalizedSuggestionIdentity(kind,null,label));
  });
  it.each([undefined,null,""])("absent saved skill %s cannot recover hash identity",skill=>{
    const stored=suggestionIdentity(kind,course,label,"calculate");
    expect(plannerHistoryIdentity(stored,skill,"calculate")).toBe(stored);
  });
  it.each([
    "not-an-identity", "practice:course-a:xyz", "practice:course-a:ABCDEF12", "practice:course-a:abcdef1",
    "practice:course-a:abcdef123", "practice:course:a:12345678", "practice:course-a:requirement-xyz",
    "practice:course-a:requirement-12345678:extra",
  ])("unrecoverable key %s is preserved, not reattributed by display label",stored=>{
    expect(plannerHistoryIdentity(stored,label,"calculate")).toBe(stored);
  });
  it("Unicode canonical equivalent labels yield the same recovered comparison, but not punctuation edits",()=>{
    const accentedA=normalizedSuggestionIdentity(kind,course,"e\u0301","r"),accentedB=normalizedSuggestionIdentity(kind,course,"é","r");
    expect(accentedA).toBe(accentedB);
    expect(normalizedSuggestionIdentity(kind,course,"a-b","r")).not.toBe(normalizedSuggestionIdentity(kind,course,"ab","r"));
  });
  it("comparison identity is stable across local-day clientKeys, while persisted task request keys are different",()=>{
    const identity=normalizedSuggestionIdentity(kind,course,label,"calculate");
    const first=suggestionKey("2026-11-09",identity),second=suggestionKey("2026-11-10",identity);
    expect(first).not.toBe(second);expect(parseSuggestionKey(first)?.identity).toBe(parseSuggestionKey(second)?.identity);
  });
  it("normalization does not mutate caller label or use an empty fallback spelling",()=>{
    const source=" ＬＩＮＥＡＲ\nＡＬＧＥＢＲＡ ";
    const normalized=normalizeSkillLabelKey(source);
    expect(normalized).toBe("linearalgebra");expect(source).toBe(" ＬＩＮＥＡＲ\nＡＬＧＥＢＲＡ ");
    expect(normalizedSuggestionIdentity(kind,course,null)).not.toBe(normalizedSuggestionIdentity(kind,course,""));
  });
});
