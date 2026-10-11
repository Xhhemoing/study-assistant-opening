import { describe, expect, it } from "vitest";
import {
  decideBlockRender,
  extractPlainParams,
  failSoftReasonLabel,
  isIllegalLink,
  isKnownSchemaVersion,
  normalizeToCatalogId,
  readSchemaVersion,
} from "./component-catalog";

const BID = "11111111-1111-4111-8111-111111111111";

describe("normalizeToCatalogId", () => {
  it("maps PM normalize aliases", () => {
    expect(normalizeToCatalogId("formula", "teach")).toBe("math");
    expect(normalizeToCatalogId("steps", "teach")).toBe("step");
    expect(normalizeToCatalogId("prompt", "prompt")).toBe("question");
    expect(normalizeToCatalogId("text", "teach")).toBe("text");
    expect(normalizeToCatalogId("example", "example")).toBe("example");
    expect(normalizeToCatalogId("draft", "meta")).toBe("draft");
    expect(normalizeToCatalogId("evidence", "meta")).toBe("evidence");
  });

  it("fails soft on unknown and answer_key", () => {
    expect(normalizeToCatalogId("html", "teach")).toBe("unknown");
    expect(normalizeToCatalogId("iframe", "teach")).toBe("unknown");
    expect(normalizeToCatalogId("answer_key", "answer_key")).toBe("unknown");
    expect(normalizeToCatalogId("text", "answer_key")).toBe("unknown");
  });
});

describe("isIllegalLink / extractPlainParams", () => {
  it("rejects javascript and data URLs", () => {
    expect(isIllegalLink("javascript:alert(1)")).toBe(true);
    expect(isIllegalLink("data:text/html,hi")).toBe(true);
    expect(isIllegalLink("https://example.com/page")).toBe(false);
  });

  it("strips illegal html/script keys and flags illegal links", () => {
    const bad = extractPlainParams({
      text: "ok",
      html: "<b>x</b>",
      href: "javascript:void(0)",
    });
    expect(bad.illegalLink).toBe(true);
    expect(bad.params.html).toBeUndefined();
    expect(bad.params.href).toBeUndefined();
    expect(bad.params.text).toBe("ok");
  });
});

describe("decideBlockRender", () => {
  it("allowlists text and never invents catalog from chat", () => {
    const d = decideBlockRender({
      blockId: BID,
      position: 0,
      blockType: "text",
      role: "teach",
      content: { text: "Hello" },
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.catalogId).toBe("text");
      expect(d.params.text).toBe("Hello");
    }
  });

  it("hidden answer_key never shows plaintext (C2)", () => {
    const d = decideBlockRender({
      blockId: BID,
      position: 0,
      blockType: "answer_key",
      role: "answer_key",
      content: null,
      answerRef: { refId: BID, revealState: "hidden" },
    });
    expect(d).toEqual({ ok: false, reason: "answer_hidden" });
    expect(failSoftReasonLabel("answer_hidden")).toContain("服务端授权");
  });

  it("unknown blockType → unknown_component", () => {
    const d = decideBlockRender({
      blockId: BID,
      position: 1,
      blockType: "OpenMAICWidget",
      role: "teach",
      content: { text: "nope" },
    });
    expect(d).toEqual({ ok: false, reason: "unknown_component" });
  });

  it("illegal link → illegal_link", () => {
    const d = decideBlockRender({
      blockId: BID,
      position: 0,
      blockType: "text",
      role: "teach",
      content: { href: "javascript:alert(1)", text: "x" },
    });
    expect(d).toEqual({ ok: false, reason: "illegal_link" });
  });

  it("unknown schema version → unknown_schema_version", () => {
    const d = decideBlockRender(
      {
        blockId: BID,
        position: 0,
        blockType: "text",
        role: "teach",
        content: { text: "x" },
      },
      { schemaVersion: "999-experimental" },
    );
    expect(d).toEqual({ ok: false, reason: "unknown_schema_version" });
  });

  it("known / missing schema version is fine", () => {
    expect(isKnownSchemaVersion(null)).toBe(true);
    expect(isKnownSchemaVersion("1")).toBe(true);
    expect(isKnownSchemaVersion("v1")).toBe(true);
    expect(isKnownSchemaVersion("2")).toBe(false);
  });
});

describe("readSchemaVersion", () => {
  it("reads extras.schemaVersion", () => {
    expect(
      readSchemaVersion({
        generationConfig: { extras: { schemaVersion: "1" } },
      }),
    ).toBe("1");
    expect(readSchemaVersion({ generationConfig: {} })).toBeNull();
  });
});
