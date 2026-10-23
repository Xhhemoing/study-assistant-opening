import { describe, expect, it } from "vitest";
import { conversationObjectHref } from "./conversation-links";
const id = "11111111-1111-4111-8111-111111111111";
describe("explicit object conversation links", () => {
  it("preserves an object's real identity, location and fragment while carrying only a conversation id", () => {
    const result = new URL(conversationObjectHref("/opening/library?tab=materials&source=source&version=2&page=3#selection", id), "https://study.invalid");
    expect(result.searchParams.get("source")).toBe("source"); expect(result.searchParams.get("version")).toBe("2");
    expect(result.searchParams.get("page")).toBe("3"); expect(result.searchParams.get("conversation")).toBe(id); expect(result.hash).toBe("#selection");
  });
  it.each(["https://example.com/opening/library", "//example.com/opening/library", "/api/opening/conversations", "/opening/settings", "/opening/assistant", "/opening/\\evil"])("does not carry identity into unsupported destinations %s", href => {
    expect(conversationObjectHref(href, id)).toBe(href);
  });
  it("does not invent an identity for a new photo task", () => {
    expect(conversationObjectHref("/opening/practice?sourceId=photo")).toBe("/opening/practice?sourceId=photo");
    expect(conversationObjectHref("/opening/practice?sourceId=photo", "invalid")).toBe("/opening/practice?sourceId=photo");
    expect(conversationObjectHref("/opening/practice?sourceId=photo", id)).toContain(`conversation=${id}`);
  });
});
