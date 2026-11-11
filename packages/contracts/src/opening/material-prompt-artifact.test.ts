import { describe, expect, it } from "vitest";
import {
  projectMaterialPromptArtifact,
  type MaterialPromptArtifactCandidate,
} from "./material-prompt-artifact";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const invalid = { ok: false, code: "INVALID_MATERIAL_PROMPT_ARTIFACT" };
function fixture(): MaterialPromptArtifactCandidate {
  const sourcePin = { sourceId: id(1), sourceVersion: 2, sha256: "a".repeat(64) };
  const prompt: MaterialPromptArtifactCandidate["prompt"] = {
    text: "在 x > 0 的条件下求 x + 2；保留所有条件。",
    interaction: { kind: "numeric", unit: "cm" },
    requiredVisuals: "none",
  };
  return {
    artifactId: id(2), revision: 3, sourcePin,
    locator: { locatorId: id(3), artifactId: id(2), artifactRevision: 3, sourcePin: { ...sourcePin } },
    prompt,
    semanticReviewCandidate: {
      kind: "structuralCandidate", artifactId: id(2), artifactRevision: 3,
      sourcePin: { ...sourcePin }, locatorId: id(3), prompt: structuredClone(prompt),
    },
  };
}
function choose(input: MaterialPromptArtifactCandidate): Extract<MaterialPromptArtifactCandidate["prompt"]["interaction"], { kind: "choice" }> {
  const interaction = { kind: "choice" as const, options: [{ id: "A", label: "条件 A" }, { id: "B", label: "条件 B" }] };
  input.prompt.interaction = interaction;
  input.semanticReviewCandidate.prompt = structuredClone(input.prompt);
  return interaction;
}
function syncPrompt(input: MaterialPromptArtifactCandidate): void {
  input.semanticReviewCandidate.prompt = structuredClone(input.prompt);
}
function extra(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

describe("material prompt artifact structural projection", () => {
  it("projects only named fields and detaches all nested data", () => {
    const input = fixture();
    const original = structuredClone(input);
    const result = projectMaterialPromptArtifact(input);
    expect(result).toEqual({ ok: true, projectionStructurallyValidatedOnly: true, projection: {
      artifactId: input.artifactId, revision: input.revision, sourcePin: input.sourcePin,
      locator: input.locator, prompt: { text: input.prompt.text, interaction: input.prompt.interaction },
    } });
    expect(input).toEqual(original);
    if (!result.ok) throw new Error("expected structural projection");
    input.prompt.text = "changed";
    input.sourcePin.sha256 = "b".repeat(64);
    input.locator.sourcePin.sourceVersion = 9;
    expect(result.projection.prompt.text).toBe(original.prompt.text);
    expect(result.projection.sourcePin).toEqual(original.sourcePin);
    expect(result.projection.locator).toEqual(original.locator);
    result.projection.locator.sourcePin.sourceId = id(9);
    expect(input.locator.sourcePin.sourceId).toBe(id(1));
  });
  it("retains full choice IDs, labels, ordering and conditions", () => {
    const input = fixture(); choose(input);
    const result = projectMaterialPromptArtifact(input);
    expect(result.ok && result.projection.prompt).toEqual({ text: input.prompt.text, interaction: input.prompt.interaction });
    if (!result.ok || result.projection.prompt.interaction.kind !== "choice") throw new Error("expected choice");
    result.projection.prompt.interaction.options[0]!.label = "mutated";
    expect(input.prompt.interaction).not.toEqual(result.projection.prompt.interaction);
  });
  it("accepts ordinary JSON and null-prototype records without relying on key order", () => {
    const input = fixture();
    const candidate = input.semanticReviewCandidate;
    candidate.sourcePin = { sha256: input.sourcePin.sha256, sourceVersion: 2, sourceId: id(1) };
    candidate.prompt.interaction = { unit: "cm", kind: "numeric" };
    const data: unknown = JSON.parse(JSON.stringify(input), (_key, value: unknown) => {
      if (value && typeof value === "object" && !Array.isArray(value)) return Object.assign(Object.create(null), value);
      return value;
    });
    expect(projectMaterialPromptArtifact(data).ok).toBe(true);
  });
  it.each([undefined, "", "m"])("supports actual numeric optional unit %s", unit => {
    const input = fixture(); input.prompt.interaction = unit === undefined ? { kind: "numeric" } : { kind: "numeric", unit };
    syncPrompt(input);
    expect(projectMaterialPromptArtifact(input).ok).toBe(true);
  });
  it("reports unavailable for matched required graphics, never degraded text", () => {
    const input = fixture(); input.prompt.requiredVisuals = "unsupported"; syncPrompt(input);
    expect(projectMaterialPromptArtifact(input)).toEqual({ ok: false, code: "MATERIAL_PROMPT_ARTIFACT_UNAVAILABLE" });
  });
  it("accepts fabricated matching facts without conferring authenticity or resolve rights", () => {
    const input = fixture();
    input.artifactId = input.locator.artifactId = input.semanticReviewCandidate.artifactId = id(99);
    input.sourcePin.sha256 = input.locator.sourcePin.sha256 = input.semanticReviewCandidate.sourcePin.sha256 = "f".repeat(64);
    const result = projectMaterialPromptArtifact(input);
    expect(result.ok).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["ok", "projection", "projectionStructurallyValidatedOnly"]);
  });
  it("cannot detect answers/URLs in ordinary text, labels or units; success is structural only", () => {
    const input = fixture();
    input.prompt.text = "Synthetic answer is 42. https://example.invalid/whole-page";
    input.prompt.interaction = { kind: "numeric", unit: "answer 42" }; syncPrompt(input);
    const numeric = projectMaterialPromptArtifact(input);
    expect(numeric.ok && numeric.projection.prompt.interaction).toEqual(input.prompt.interaction);
    const interaction = choose(input);
    interaction.options[0]!.label = "Correct answer: 42";
    syncPrompt(input);
    const choice = projectMaterialPromptArtifact(input);
    expect(choice.ok && choice.projection.prompt).toEqual({ text: input.prompt.text, interaction: input.prompt.interaction });
  });

  const mismatches: [string, (input: MaterialPromptArtifactCandidate) => void][] = [
    ["locator artifact", x => { x.locator.artifactId = id(9); }],
    ["locator revision", x => { x.locator.artifactRevision++; }],
    ["locator source", x => { x.locator.sourcePin.sourceId = id(9); }],
    ["locator version", x => { x.locator.sourcePin.sourceVersion++; }],
    ["locator SHA", x => { x.locator.sourcePin.sha256 = "b".repeat(64); }],
    ["candidate artifact", x => { x.semanticReviewCandidate.artifactId = id(9); }],
    ["candidate revision", x => { x.semanticReviewCandidate.artifactRevision++; }],
    ["candidate source", x => { x.semanticReviewCandidate.sourcePin.sourceId = id(9); }],
    ["candidate version", x => { x.semanticReviewCandidate.sourcePin.sourceVersion++; }],
    ["candidate SHA", x => { x.semanticReviewCandidate.sourcePin.sha256 = "b".repeat(64); }],
    ["candidate locator", x => { x.semanticReviewCandidate.locatorId = id(9); }],
    ["candidate text", x => { x.semanticReviewCandidate.prompt.text += " extra condition"; }],
    ["candidate unit", x => { x.semanticReviewCandidate.prompt.interaction = { kind: "numeric", unit: "m" }; }],
    ["candidate kind", x => { choose(x); x.semanticReviewCandidate.prompt.interaction = { kind: "numeric" }; }],
    ["candidate option ID", x => { choose(x); const y = x.semanticReviewCandidate.prompt.interaction; if (y.kind === "choice") y.options[0]!.id = "C"; }],
    ["candidate option label", x => { choose(x); const y = x.semanticReviewCandidate.prompt.interaction; if (y.kind === "choice") y.options[0]!.label += " changed"; }],
    ["candidate option order", x => { choose(x); const y = x.semanticReviewCandidate.prompt.interaction; if (y.kind === "choice") y.options.reverse(); }],
    ["candidate option count", x => { choose(x); const y = x.semanticReviewCandidate.prompt.interaction; if (y.kind === "choice") y.options.push({ id: "C", label: "third" }); }],
    ["candidate visuals", x => { x.semanticReviewCandidate.prompt.requiredVisuals = "unsupported"; }],
    ["exact SHA case", x => { x.locator.sourcePin.sha256 = "A".repeat(64); }],
  ];
  it.each(mismatches)("rejects exact identity mismatch: %s", (_name, mutate) => {
    const input = fixture(); mutate(input); expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
  it.each(["answer", "key", "rawChunk", "wholePageUrl", "ownerUserId", "reviewerId", "approved", "authority", "authorized", "grant", "ready", "auth"])("rejects private/authority field %s at each object boundary", key => {
    for (const location of ["root", "pin", "locator", "prompt", "interaction", "candidate"] as const) {
      const input = fixture();
      const targets = { root: input, pin: input.sourcePin, locator: input.locator, prompt: input.prompt,
        interaction: input.prompt.interaction, candidate: input.semanticReviewCandidate };
      extra(targets[location], key, "SYNTHETIC_PRIVATE_MARKER");
      expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
    }
  });
  it.each(["authorityTrue", "grant", "ready", "approved", "structurallyValidated"])("rejects review kind %s", kind => {
    const input = fixture(); extra(input.semanticReviewCandidate, "kind", kind);
    expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
  it.each([null, undefined, true, 1, "private", [], () => 1, 1n, Symbol("secret")])("rejects non-record root %s", input => {
    expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])("rejects revision %s", revision => {
    const input = fixture(); input.revision = revision; expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects source version %s", version => {
    const input = fixture(); input.sourcePin.sourceVersion = version; expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
  it.each(["", "a".repeat(63), "a".repeat(65), "g".repeat(64)])("rejects malformed SHA %s", sha => {
    const input = fixture(); input.sourcePin.sha256 = sha; expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
  it("does not normalize SHA, validates supplied upper-case pins and zero source version", () => {
    const input = fixture();
    for (const pin of [input.sourcePin, input.locator.sourcePin, input.semanticReviewCandidate.sourcePin]) {
      pin.sha256 = "A".repeat(64); pin.sourceVersion = 0;
    }
    expect(projectMaterialPromptArtifact(input).ok).toBe(true);
  });
  it.each(["", " ", "\t\r\n", "x".repeat(8001)])("rejects empty/oversized prompt", text => {
    const input = fixture(); input.prompt.text = text; syncPrompt(input); expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
  it.each(["e\u0301", "bad\ud800", "bad\udfff", "a\u0000b", "a\u000bb", "a\u007fb", "a\u0085b", "a\u200bb", "a\u202eb", "a\ufeffb"])("rejects non-NFC/invalid Unicode %#", text => {
    const input = fixture(); input.prompt.text = text; syncPrompt(input); expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
  it("accepts bounded full text and valid Unicode without truncation", () => {
    const input = fixture(); input.prompt.text = "é中文😀\t\n\r".padEnd(8000, "x"); syncPrompt(input);
    const result = projectMaterialPromptArtifact(input);
    expect(result.ok && result.projection.prompt.text).toBe(input.prompt.text);
  });
  it.each([1, 7])("rejects %i options per actual teaching schema", count => {
    const input = fixture(); input.prompt.interaction = { kind: "choice", options: Array.from({ length: count }, (_, i) => ({ id: String(i), label: "x" })) }; syncPrompt(input);
    expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
  it.each(["duplicate", "id", "label", "unit", "private option"])("enforces actual interaction limits: %s", reason => {
    const input = fixture(); choose(input);
    if (input.prompt.interaction.kind !== "choice") throw new Error("choice");
    const option = input.prompt.interaction.options[0]!;
    if (reason === "duplicate") input.prompt.interaction.options[1]!.id = option.id;
    if (reason === "id") option.id = "i".repeat(21);
    if (reason === "label") option.label = "l".repeat(501);
    if (reason === "unit") input.prompt.interaction = { kind: "numeric", unit: "u".repeat(41) };
    if (reason === "private option") extra(option, "answer", "secret");
    syncPrompt(input); expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
});

describe("bounded own-descriptor boundary (ordinary data, not Proxy sandbox)", () => {
  it.each(["root", "nested", "array"])("rejects %s getter without invoking it or leaking errors", location => {
    const input = fixture(); choose(input); let invoked = 0;
    const target = location === "root" ? input : location === "nested" ? input.prompt : (input.prompt.interaction as { options: unknown[] }).options;
    const key = location === "root" ? "artifactId" : location === "nested" ? "text" : "0";
    Object.defineProperty(target, key, { enumerable: true, get() { invoked++; throw new Error("SYNTHETIC_PRIVATE_MARKER"); } });
    expect(projectMaterialPromptArtifact(input)).toEqual(invalid); expect(invoked).toBe(0);
  });
  it("rejects setter-only descriptors without invoking them", () => {
    const input = fixture(); let invoked = 0;
    Object.defineProperty(input.prompt, "text", { enumerable: true, set() { invoked++; } });
    expect(projectMaterialPromptArtifact(input)).toEqual(invalid); expect(invoked).toBe(0);
  });
  it.each(["symbol", "hidden", "prototype", "missing", "undefined", "function", "bigint", "date", "map", "boxed", "pollution"])("rejects hostile own-data form: %s", form => {
    const input = fixture();
    if (form === "symbol") extra(input.prompt, Symbol("private"), 1);
    if (form === "hidden") Object.defineProperty(input.prompt, "secret", { value: "secret" });
    if (form === "prototype") Object.setPrototypeOf(input.prompt, { secret: "inherited" });
    if (form === "missing") Reflect.deleteProperty(input.prompt, "text");
    if (form === "undefined") extra(input.prompt, "text", undefined);
    if (form === "function") extra(input.prompt, "text", () => "secret");
    if (form === "bigint") extra(input.prompt, "text", 3n);
    if (form === "date") extra(input.prompt, "text", new Date(0));
    if (form === "map") extra(input.prompt, "text", new Map());
    if (form === "boxed") extra(input.prompt, "text", new String("secret"));
    if (form === "pollution") extra(input.prompt, "__proto__", { secret: "secret" });
    expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
  it.each(["hole", "01", "-1", "2", "1.5", "4294967295", "extra", "symbol", "hidden", "prototype", "too long"])("rejects array numeric/extraneous form: %s", form => {
    const input = fixture(); choose(input);
    const options = (input.prompt.interaction as { options: unknown[] }).options;
    if (form === "hole") Reflect.deleteProperty(options, "0");
    else if (form === "symbol") extra(options, Symbol("x"), "secret");
    else if (form === "hidden") Object.defineProperty(options, "hidden", { value: 1 });
    else if (form === "prototype") Object.setPrototypeOf(options, null);
    else if (form === "too long") options.length = 9;
    else extra(options, form, "private");
    expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
  it.each(["depth", "cycle", "nodes", "characters", "keys", "long key", "NFC key", "format key"])("rejects bounded/invalid snapshot: %s", bound => {
    const input = fixture();
    if (bound === "depth" || bound === "cycle") {
      let value: unknown = input;
      if (bound === "depth") for (let i = 0; i < 10; i++) value = { value };
      extra(input, "extra", value);
    }
    if (bound === "nodes") extra(input, "extra", Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => Array(8).fill(null))));
    if (bound === "characters") for (let i = 0; i < 5; i++) extra(input, `x${i}`, "x".repeat(8000));
    if (bound === "keys") for (let i = 0; i < 17; i++) extra(input, `x${i}`, i);
    if (bound === "long key") extra(input, "x".repeat(65), 1);
    if (bound === "NFC key") extra(input, "e\u0301", 1);
    if (bound === "format key") extra(input, "a\u200bb", 1);
    expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
  it("rejects forged unknown graphics/URLs instead of silently removing them", () => {
    const input = fixture(); extra(input.prompt, "imageUrl", "https://example.invalid/whole-page");
    expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
  it("rejects absent required conditions/interaction/review instead of supplying defaults", () => {
    for (const key of ["text", "interaction", "requiredVisuals"]) {
      const input = fixture(); Reflect.deleteProperty(input.prompt, key);
      expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
    }
    const input = fixture(); Reflect.deleteProperty(input, "semanticReviewCandidate");
    expect(projectMaterialPromptArtifact(input)).toEqual(invalid);
  });
});
