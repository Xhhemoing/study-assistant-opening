import { describe, expect, it } from "vitest";
import { checkDingTalk, syncDingTalk } from "./sync-dingtalk";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const base = {
  id: "33333333-3333-4333-8333-333333333333",
  version: 2,
  kind: "dingtalk" as const,
  label: "DingTalk",
  state: "ready" as const,
  allowedScopes: [],
  lastSuccessAt: null,
  errorCode: null,
};
const deps = (connection = base, allowedScopes: string[] = []) => ({
  connections: { get: async () => connection },
  imports: {},
  sources: {},
  privacy: {},
  getGrantedScopes: async () => allowedScopes,
});
const checkDeps = (connection = base, allowedScopes: string[] = []) => ({
  connections: { get: async () => connection },
  getGrantedScopes: async () => allowedScopes,
});

describe("dingtalk sync boundary", () => {
  it("does not read history without an explicitly granted read capability", async () => {
    const result = await syncDingTalk(deps(base, ["robot.send"]), {
      ...scope,
      connectionId: base.id,
    });
    expect(result).toEqual({
      status: "needs_authorization",
      imported: 0,
      skipped: 0,
      allowedScopes: ["robot.send"],
    });
  });

  it("refuses historical reads even when a read capability is granted", async () => {
    const result = await syncDingTalk(deps({ ...base, allowedScopes: ["messages.read"] }, ["messages.read"]), {
      ...scope,
      connectionId: base.id,
    });
    expect(result).toEqual({
      status: "unsupported_history_read",
      imported: 0,
      skipped: 0,
      allowedScopes: ["messages.read"],
    });
  });
});

describe("dingtalk check boundary", () => {
  it("reports needs_authorization without calling remote APIs when no read capability", async () => {
    const result = await checkDingTalk(checkDeps({ ...base, state: "needs_authorization" }, ["robot.send"]), {
      ...scope,
      connectionId: base.id,
    });
    expect(result).toEqual({
      ok: false,
      kind: "dingtalk",
      status: "needs_authorization",
      allowedScopes: ["robot.send"],
    });
  });

  it("reports ready when an internal read capability is present without claiming history pull", async () => {
    const result = await checkDingTalk(checkDeps(base, ["messages.read"]), {
      ...scope,
      connectionId: base.id,
    });
    expect(result).toEqual({
      ok: true,
      kind: "dingtalk",
      status: "ready",
      allowedScopes: ["messages.read"],
    });
  });

  it("reports unsupported_history_read for authorized non-ready states", async () => {
    const result = await checkDingTalk(
      checkDeps({ ...base, state: "error" as const }, ["events.read"]),
      { ...scope, connectionId: base.id },
    );
    expect(result).toEqual({
      ok: true,
      kind: "dingtalk",
      status: "unsupported_history_read",
      allowedScopes: ["events.read"],
    });
  });
});
