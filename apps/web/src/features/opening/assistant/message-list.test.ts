import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer, logicalSendFingerprint, nextClientKey } from "./composer";
import { MessageList } from "./message-list";
import { citationChipLabel, sourceDownloadHref, sourceViewerHref } from "../inbox/source-viewer";

describe("logical send clientKey", () => {
  let n = 0;
  const mint = () => `ck-test-${++n}`;

  it("reuses the clientKey when the same unconfirmed intent is retried", () => {
    const fingerprint = logicalSendFingerprint({ text: "解释牛顿第二定律", mode: "explain" });
    const first = nextClientKey({
      clientKey: null,
      fingerprint: null,
      nextFingerprint: fingerprint,
      mint,
    });
    const retry = nextClientKey({
      clientKey: first.clientKey,
      fingerprint: first.fingerprint,
      nextFingerprint: fingerprint,
      mint,
    });

    expect(retry.clientKey).toBe(first.clientKey);
    expect(retry.clientKey).toBe("ck-test-1");
  });

  it("mints a new clientKey when the message changes", () => {
    const first = nextClientKey({
      clientKey: "ck-held",
      fingerprint: logicalSendFingerprint({ text: "旧问题", mode: "explain" }),
      nextFingerprint: logicalSendFingerprint({ text: "新问题", mode: "explain" }),
      mint,
    });

    expect(first.clientKey).not.toBe("ck-held");
    expect(first.fingerprint).toBe(logicalSendFingerprint({ text: "新问题", mode: "explain" }));
  });

  it("mints a new clientKey after a successful send clears the held key", () => {
    const fingerprint = logicalSendFingerprint({ text: "下一问", mode: "hint" });
    const next = nextClientKey({
      clientKey: null,
      fingerprint: null,
      nextFingerprint: fingerprint,
      mint,
    });

    expect(next.clientKey).not.toBe("ck-test-1");
    expect(next.fingerprint).toBe(fingerprint);
  });

  it("treats a changed mode as a different logical send", () => {
    const held = logicalSendFingerprint({ text: "同一句", mode: "explain" });
    const changed = logicalSendFingerprint({ text: "同一句", mode: "hint" });
    const next = nextClientKey({
      clientKey: "ck-held",
      fingerprint: held,
      nextFingerprint: changed,
      mint,
    });

    expect(changed).not.toBe(held);
    expect(next.clientKey).not.toBe("ck-held");
    expect(next.fingerprint).toBe(changed);
  });

  it("binds source ids, page, and chunk so text+mode alone cannot reuse the key", () => {
    const text = "解释这一页";
    const mode = "explain" as const;
    const sourceA = "11111111-1111-4111-8111-111111111111";
    const sourceB = "22222222-2222-4222-8222-222222222222";
    const chunk = "33333333-3333-4333-8333-333333333333";
    const held = logicalSendFingerprint({
      text, mode, sourceIds: [sourceB, sourceA], currentPage: 2, chunkId: chunk,
    });
    const sameMaterials = logicalSendFingerprint({
      text, mode, sourceIds: [sourceA, sourceB], currentPage: 2, chunkId: chunk,
    });
    const otherPage = logicalSendFingerprint({
      text, mode, sourceIds: [sourceA, sourceB], currentPage: 3, chunkId: chunk,
    });
    const textOnly = logicalSendFingerprint({ text, mode });

    expect(sameMaterials).toBe(held);
    expect(otherPage).not.toBe(held);
    expect(textOnly).not.toBe(held);
    const retry = nextClientKey({
      clientKey: "ck-held",
      fingerprint: held,
      nextFingerprint: sameMaterials,
      mint,
    });
    expect(retry.clientKey).toBe("ck-held");
  });

  it("reuses the held key for an explicit outcome_unknown retry", () => {
    const fingerprint = logicalSendFingerprint({
      text: "同一问", mode: "explain", sourceIds: [], currentPage: null, chunkId: null,
    });
    const retry = nextClientKey({
      clientKey: "ck-unknown", fingerprint, nextFingerprint: fingerprint, mint,
    });
    expect(retry.clientKey).toBe("ck-unknown");
  });
});

describe("opening assistant copy", () => {
  it("describes free conversation in the composer", () => {
    const html = renderToStaticMarkup(createElement(Composer, {
      draft: "",
      onDraftChange: () => undefined,
      onSubmit: () => undefined,
    }));

    expect(html).toContain("自由交流，或基于已选材料提问…");
  });

  it("invites free conversation when no messages exist", () => {
    const html = renderToStaticMarkup(createElement(MessageList, {
      messages: [],
    }));

    expect(html).toContain("自由交流");
    expect(html).not.toContain("指定材料后即可提问");
  });
});

describe("MessageList", () => {
  it("renders model text as text instead of executable HTML", () => {
    const html = renderToStaticMarkup(createElement(MessageList, {
      messages: [{
        id: "turn-html",
        role: "assistant",
        text: "<script>alert('xss')</script>",
        citationLabels: [],
        citations: [],
        status: "complete",
      }],
    }));

    expect(html).toContain("&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("renders outcome_unknown as an explicit no-resubmit warning, not failed", () => {
    const html = renderToStaticMarkup(createElement(MessageList, {
      messages: [{
        id: "turn-1",
        role: "assistant",
        text: "provider timeout",
        citationLabels: [],
        status: "outcome_unknown",
      }],
    }));

    expect(html).toContain(">结果状态未知，请勿重复提交<");
    expect(html).not.toContain("本轮失败");
  });

  it("opens the cited source version instead of the unlabeled latest file", () => {
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const html = renderToStaticMarkup(createElement(MessageList, {
      messages: [{
        id: "turn-cite",
        role: "assistant",
        text: "见材料第 2 页",
        citationLabels: ["p.2"],
        citations: [{
          chunkId: "44444444-4444-4444-8444-444444444444",
          sourceId,
          sourceVersion: 3,
          label: "p.2",
        }],
        status: "complete",
      }],
      currentVersions: { [sourceId]: 5 },
    }));

    const viewerHref = sourceViewerHref(sourceId, 3).replaceAll("&", "&amp;");
    expect(html).toContain(`href="${viewerHref}"`);
    expect(html).toContain(`href="${sourceDownloadHref(sourceId, 3)}"`);
    expect(html).toContain("v3");
    expect(html).toContain("p.2");
    expect(html).toContain("不是当前版本");
  });

  it("primary chip href includes page when citation.page is set and label is readable", () => {
    const sourceId = "22222222-2222-4222-8222-222222222222";
    const html = renderToStaticMarkup(createElement(MessageList, {
      messages: [{
        id: "turn-page",
        role: "assistant",
        text: "见第 3 页",
        citationLabels: ["notes.pdf · 第 3 页"],
        citations: [{
          chunkId: "44444444-4444-4444-8444-444444444444",
          sourceId,
          sourceVersion: 1,
          label: "source uuid v1 page 3",
          page: 3,
        }],
        status: "complete",
      }],
      sourceNames: { [sourceId]: "notes.pdf" },
    }));

    const viewerHref = sourceViewerHref(sourceId, 1, { page: 3 }).replaceAll("&", "&amp;");
    expect(html).toContain(`href="${viewerHref}"`);
    expect(html).toContain("page=3");
    expect(html).toContain(citationChipLabel({
      label: "source uuid v1 page 3",
      page: 3,
      sourceName: "notes.pdf",
    }));
    expect(html).toContain("notes.pdf · 第 3 页");
    expect(html).toContain(`href="${sourceDownloadHref(sourceId, 1, 3)}"`);
  });

  it("shows a general badge when materials were selected but citations are empty", () => {
    const html = renderToStaticMarkup(createElement(MessageList, {
      messages: [{
        id: "turn-general",
        role: "assistant",
        text: "这是一般说明",
        citationLabels: [],
        citations: [],
        status: "complete",
        hadMaterialContext: true,
      }],
    }));
    expect(html).toContain("一般说明（未引用材料）");
    expect(html).not.toContain("出处：");
  });

  it("keeps 出处 chips when citations are present and does not show the general badge", () => {
    const html = renderToStaticMarkup(createElement(MessageList, {
      messages: [{
        id: "turn-cited",
        role: "assistant",
        text: "见材料",
        citationLabels: ["p.1"],
        citations: [{
          chunkId: "44444444-4444-4444-8444-444444444444",
          sourceId: "22222222-2222-4222-8222-222222222222",
          sourceVersion: 1,
          label: "p.1",
        }],
        status: "complete",
        hadMaterialContext: true,
      }],
    }));
    expect(html).toContain("出处：");
    expect(html).toContain("p.1");
    expect(html).not.toContain("一般说明（未引用材料）");
  });

  it("does not show a general badge for free-chat answers with no material context", () => {
    const html = renderToStaticMarkup(createElement(MessageList, {
      messages: [{
        id: "turn-free",
        role: "assistant",
        text: "自由交流回答",
        citationLabels: [],
        citations: [],
        status: "complete",
        hadMaterialContext: false,
      }],
    }));
    expect(html).not.toContain("一般说明（未引用材料）");
    expect(html).not.toContain("出处：");
  });
});
