import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { systemQueryReceiptSchema, turnRecordSchema } from "@aistudy/contracts";
import { appendEphemeralResponseIfActive } from "./assistant-view";
import { LearningProse, sameLearningProseContent } from "./learning-prose";
import { MessageList } from "./message-list";
import { ephemeralHistoryFromMessages, messagesFromTurns } from "./message-model";
import { isQueryEvidenceHref, queryEvidenceLinks } from "./query-evidence-links";

const id = "11111111-1111-4111-8111-111111111111";
const material = `/opening/library?tab=materials&source=${id}&version=1&page=1`;
const settings = "/opening/settings";
const text = `[甲讲义.txt · 物理页1](${material})\n\n[已保存的模型设置](${settings})`;
const authorization = { purpose: "system_record_lookup", workspaceId: id, principalId: id, role: "workspace_owner", permissionRevision: `owner:${id}:privacy:0` };
const asOf = "2026-10-19T00:00:00Z";
const common = { authorization, status: "ok", reason: "read", asOf, version: "v1", nextOffset: null, data: [] };
const receipt = systemQueryReceiptSchema.parse({ authorization, version: "study-query-v1", asOf, privacyEpoch: 0, mode: "deterministic", status: "ok", reason: "read", results: [
  { ...common, name: "materials", sourceRefs: [{ sourceId: id, sourceVersion: 1 }], evidence: [{ id: "material", kind: "material", title: "甲讲义.txt · 物理页1", href: material, sourceId: id, sourceVersion: 1, physicalPage: 1 }] },
  { ...common, name: "settings", sourceRefs: [], evidence: [{ id: "settings", kind: "settings", title: "已保存的模型设置", href: settings }] },
] });
const anchors = (html: string) => [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]?.replaceAll("&amp;", "&"));

describe("server-owned query evidence links", () => {
  const saved = messagesFromTurns([turnRecordSchema.parse({ id, conversationId: id, role: "assistant", text, citations: [], createdAt: asOf, mode: "explain", status: "complete", systemQuery: receipt })]);
  const temporary = appendEphemeralResponseIfActive([], { clientKey: "q", text: "查询", output: { requestId: id, text, systemQuery: receipt } }, new AbortController().signal);

  for (const [origin, messages] of [["saved reload", saved], ["temporary response", temporary]] as const) {
    for (const proseEnabled of [true, false]) {
      it(`renders exact evidence anchors for ${origin}, prose=${proseEnabled}`, () => {
        const html = renderToStaticMarkup(createElement(MessageList, { messages: [...messages], historyTruncated: false, proseEnabled, artifactsEnabled: false }));
        expect(anchors(html)).toEqual([material, settings]);
        expect(html).toContain("甲讲义.txt · 物理页1");
        expect(html).toContain("已保存的模型设置");
      });
    }
  }

  it("keeps receipt evidence out of temporary model history", () => {
    expect(ephemeralHistoryFromMessages(temporary)).toEqual([{ role: "user", text: "查询" }, { role: "assistant", text }]);
    expect(saved[0]?.systemQuery).toBe(true);
    expect(temporary[1]?.queryEvidenceLinks).toEqual(queryEvidenceLinks(receipt));
  });

  it("requires exact receipt membership without changing ordinary Markdown policy", () => {
    const unapproved = renderToStaticMarkup(createElement(LearningProse, { text }));
    expect(anchors(unapproved)).toEqual([]);
    const approved = renderToStaticMarkup(createElement(LearningProse, { text, queryEvidenceLinks: [{ href: settings, label: "设置" }] }));
    expect(anchors(approved)).toEqual([settings]);
    expect(sameLearningProseContent({ text, queryEvidenceLinks: queryEvidenceLinks(receipt) }, { text })).toBe(false);
    expect(sameLearningProseContent({ text }, { text, queryEvidenceLinks: queryEvidenceLinks(receipt) })).toBe(false);
    expect(sameLearningProseContent({ text, queryEvidenceLinks: [{ href: settings, label: "设置" }] }, { text, queryEvidenceLinks: [{ href: "/opening/today", label: "设置" }] })).toBe(false);
  });

  it.each(["//evil.test/path", "https://evil.test", "javascript:alert(1)", "data:text/html,x", "/opening/admin", "/opening/settings?redirect=https://evil.test", "/opening/../settings", "/opening/%2e%2e/settings", "/opening/%252e%252e/settings", "/opening//settings", "/opening/settings#x", "/opening/\\settings", `${material}&source=${id}`, `${material}&redirect=x`])("rejects non-executor route %s even when supplied as evidence", href => {
    expect(isQueryEvidenceHref(href)).toBe(false);
    // External links retain their existing ordinary Markdown policy; receipt authority adds no exception.
    if (/^(?:https?:|mailto:)/.test(href)) return;
    const html = renderToStaticMarkup(createElement(LearningProse, { text: `[label](${href})`, queryEvidenceLinks: [{ href, label: "label" }] }));
    expect(anchors(html)).toEqual([]);
    const plain = renderToStaticMarkup(createElement(MessageList, { messages: [{ id, role: "assistant", text: "label", citations: [], citationLabels: [], queryEvidenceLinks: [{ href, label: "label" }] }], historyTruncated: false, proseEnabled: false, artifactsEnabled: false }));
    expect(anchors(plain)).toEqual([]);
  });

  it("admits only the executor's known read routes", () => {
    for (const href of [material, settings, "/opening/today", "/opening/library", `/opening/courses/${id}`, `/opening/courses/${id}?tab=records`, `/opening/courses/${id}/study`]) expect(isQueryEvidenceHref(href)).toBe(true);
    expect(isQueryEvidenceHref(`${material}\n`)).toBe(false);
  });
});
