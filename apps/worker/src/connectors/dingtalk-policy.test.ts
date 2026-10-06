import { describe, expect, it } from "vitest";
import { canReadDingTalkResource } from "./dingtalk-policy";

describe("dingtalk permission policy", () => {
  it("does not treat robot send permission as permission to read messages", () => {
    expect(canReadDingTalkResource("messages.read", ["robot.send"])).toBe(false);
  });
});
