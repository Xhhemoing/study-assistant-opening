import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { ApiError } from "../../auth/service";
import { createOpeningConnectionService } from "./service";

const scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
};

const imapConnection = {
  id: "33333333-3333-4333-8333-333333333333",
  version: 1,
  kind: "imap" as const,
  label: "School mail",
  state: "ready" as const,
  allowedScopes: [] as string[],
  lastSuccessAt: null,
  errorCode: null,
};

const dingtalkConnection = {
  ...imapConnection,
  id: "44444444-4444-4444-8444-444444444444",
  kind: "dingtalk" as const,
  state: "needs_authorization" as const,
};

const clientKey = randomUUID();

function fakeConnections(connection: typeof imapConnection | typeof dingtalkConnection) {
  return {
    list: vi.fn(),
    get: vi.fn(async () => connection),
    createImap: vi.fn(),
    createDingtalk: vi.fn(),
    putCredential: vi.fn(),
    revoke: vi.fn(),
  };
}

describe("opening connection IMAP HTTP boundary", () => {
  it("routes IMAP sync through sync-mail and does not throw the old 503 adapter stub", async () => {
    const syncMail = vi.fn(async () => ({
      imported: 2,
      skipped: 1,
      cursor: { folder: "INBOX", uidValidity: "7", lastUid: 12 },
    }));
    const service = createOpeningConnectionService({} as Sql, {
      connections: fakeConnections(imapConnection) as never,
      syncMail,
    });
    const result = await service.unavailable(scope, imapConnection.id, { clientKey });
    expect(syncMail).toHaveBeenCalledWith({ connectionId: imapConnection.id });
    expect(result).toEqual({
      imported: 2,
      skipped: 1,
      cursor: { folder: "INBOX", uidValidity: "7", lastUid: 12 },
    });
  });

  it("returns IMAP check success without opening a real remote socket when injected", async () => {
    const checkMail = vi.fn(async () => ({ ok: true as const, kind: "imap" as const }));
    const service = createOpeningConnectionService({} as Sql, {
      connections: fakeConnections(imapConnection) as never,
      checkMail,
    });
    await expect(service.checkUnavailable(scope, imapConnection.id, { clientKey })).resolves.toEqual({
      ok: true,
      kind: "imap",
    });
    expect(checkMail).toHaveBeenCalledWith({ connectionId: imapConnection.id });
  });

  it("maps IMAP check/sync adapter failures to ApiError codes", async () => {
    const service = createOpeningConnectionService({} as Sql, {
      connections: fakeConnections(imapConnection) as never,
      checkMail: async () => {
        throw new Error("IMAP host is not authorized");
      },
      syncMail: async () => {
        throw new Error("imap credential is missing");
      },
    });
    await expect(service.checkUnavailable(scope, imapConnection.id, { clientKey })).rejects.toMatchObject({
      code: "VALIDATION",
      status: 400,
      message: "IMAP 主机尚未由管理员授权。",
    });
    await expect(service.unavailable(scope, imapConnection.id, { clientKey })).rejects.toMatchObject({
      code: "CONFIGURATION",
      status: 503,
      message: "连接凭据尚未配置。",
    });
  });

  it("keeps revoked connections at 409 for both check and sync", async () => {
    const service = createOpeningConnectionService({} as Sql, {
      connections: fakeConnections({ ...imapConnection, state: "revoked" }) as never,
      syncMail: vi.fn(),
      checkMail: vi.fn(),
    });
    await expect(service.checkUnavailable(scope, imapConnection.id, { clientKey })).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
    await expect(service.unavailable(scope, imapConnection.id, { clientKey })).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
  });

  it("rejects unauthorized IMAP hosts at create time with VALIDATION", async () => {
    const previous = process.env.OPENING_IMAP_ALLOWED_HOSTS;
    process.env.OPENING_IMAP_ALLOWED_HOSTS = "mail.example.edu";
    try {
      const service = createOpeningConnectionService({} as Sql, {
        connections: fakeConnections(imapConnection) as never,
      });
      await expect(
        service.createImap(scope, {
          label: "School mail",
          host: "evil.example.com",
          port: 993,
          tlsMode: "implicit",
          username: "student",
          folders: ["INBOX"],
          since: "2026-09-01T00:00:00.000Z",
          clientKey,
        }),
      ).rejects.toBeInstanceOf(ApiError);
      await expect(
        service.createImap(scope, {
          label: "School mail",
          host: "evil.example.com",
          port: 993,
          tlsMode: "implicit",
          username: "student",
          folders: ["INBOX"],
          since: "2026-09-01T00:00:00.000Z",
          clientKey,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
    } finally {
      if (previous === undefined) delete process.env.OPENING_IMAP_ALLOWED_HOSTS;
      else process.env.OPENING_IMAP_ALLOWED_HOSTS = previous;
    }
  });

  it("routes DingTalk check through the durable local check handler", async () => {
    const checkDingTalk = vi.fn(async () => ({
      ok: false as const,
      kind: "dingtalk" as const,
      status: "needs_authorization" as const,
      allowedScopes: [] as string[],
    }));
    const service = createOpeningConnectionService({} as Sql, {
      connections: fakeConnections(dingtalkConnection) as never,
      checkDingTalk,
    });
    await expect(service.checkUnavailable(scope, dingtalkConnection.id, { clientKey })).resolves.toEqual({
      ok: false,
      kind: "dingtalk",
      status: "needs_authorization",
      allowedScopes: [],
    });
    expect(checkDingTalk).toHaveBeenCalledWith({ connectionId: dingtalkConnection.id });
  });

  it("returns DingTalk ready check without inventing a remote health probe", async () => {
    const ready = {
      ...dingtalkConnection,
      state: "ready" as const,
      allowedScopes: ["messages.read"],
    };
    const checkDingTalk = vi.fn(async () => ({
      ok: true as const,
      kind: "dingtalk" as const,
      status: "ready" as const,
      allowedScopes: ["messages.read"],
    }));
    const service = createOpeningConnectionService({} as Sql, {
      connections: fakeConnections(ready) as never,
      checkDingTalk,
    });
    await expect(service.checkUnavailable(scope, ready.id, { clientKey })).resolves.toEqual({
      ok: true,
      kind: "dingtalk",
      status: "ready",
      allowedScopes: ["messages.read"],
    });
  });
});
