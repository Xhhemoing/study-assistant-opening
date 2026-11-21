import { describe, expect, it } from "vitest";
import { allowsPublicTryChallenge, publicTryEntry } from "../access-policy";
import { challenges, gradeTry, readTryReceipt } from "./challenges";

describe("public try policy", () => {
  it.each(["0", "false", "no", " NO "])("honors explicit opt-out %s", value => {
    expect(allowsPublicTryChallenge({ OPENING_PUBLIC_TRY: value })).toBe(false);
  });
  it.each(["development", "production"] as const)("opens /try in %s", NODE_ENV => {
    expect(allowsPublicTryChallenge({ NODE_ENV })).toBe(true);
    expect(allowsPublicTryChallenge({ NODE_ENV, OPENING_RELEASE: "1" })).toBe(true);
  });
  it("follows the registration policy and keeps the handoff internal", () => {
    expect(publicTryEntry({ NODE_ENV: "development" })).toBe("/register");
    expect(publicTryEntry({ NODE_ENV: "production" })).toBe("/login");
    expect(publicTryEntry({ OPENING_RELEASE: "1" })).toBe("/login");
    expect(publicTryEntry({ NODE_ENV: "production", OPENING_RELEASE: "0" })).toBe("/register");
  });
});

describe("worked derivations", () => {
  it.each([
    ["limit", 2, 0],
    ["integral", 3, 2],
    ["matrix", 3, 1],
  ] as const)("grades every step and reason independently for %s", (id, step, reason) => {
    const question = challenges.find(item => item.id === id)!;
    expect(question.steps.length).toBeGreaterThanOrEqual(4);
    expect(question.steps.length).toBeLessThanOrEqual(5);
    expect(question.reasons).toHaveLength(3);
    question.steps.forEach((_, s) => question.reasons.forEach((__, r) => {
      expect(gradeTry(question, s, r)).toEqual({ stepCorrect: s === step, reasonCorrect: r === reason });
    }));
  });
  it("rejects damaged or out-of-range tab data", () => {
    for (const raw of ["null", "{", "[]", '{"challenge":"limit","step":12,"reason":0}',
      '{"challenge":"limit","step":2,"reason":"0"}', '{"challenge":"other","step":2,"reason":0}']) {
      expect(readTryReceipt(raw)).toBeNull();
    }
    expect(readTryReceipt('{"challenge":"limit","step":2,"reason":0}')).toEqual({ challenge: "limit", step: 2, reason: 0 });
  });
});
