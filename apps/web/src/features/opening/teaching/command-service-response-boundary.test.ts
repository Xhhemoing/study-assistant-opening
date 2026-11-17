import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createOpeningTeachingCommandService } from "./command-service";

const io = vi.hoisted(() => ({ factory: vi.fn(), owned: vi.fn(), execute: vi.fn() }));
vi.mock("@aistudy/database", () => ({ createOpeningTeachingCommandsRepository: io.factory }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) }, activityId = id(3), blockId = id(4);
const sql = {} as Sql;
const request = { clientKey: "command-boundary-key", kind: "branch", blockId, expectedVersion: 0, expectedPathVersion: 1,
  expectedRevisionNumber: 2, targetBlockId: id(5), branchLabel: "Branch", prompt: "Explain this" };
const success = () => ({ ok: true, kind: "branch", activityId, contentVersion: 0, pathVersion: 2, revisionNumber: 2,
  checkpointJson: { currentBlockId: blockId }, replayed: false });
const conflict = () => ({ ok: false, conflict: "stale_revision", message: "Reread the original", currentContentVersion: 0, currentPathVersion: 1, currentRevisionNumber: 3 });
function deferred() { let resolve!: (value?: unknown) => void; const promise = new Promise<unknown>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { vi.resetAllMocks(); io.factory.mockReturnValue({ assertOwned: io.owned, executeCommand: io.execute });
  io.owned.mockResolvedValue(undefined); io.execute.mockResolvedValue(success()); });

describe("teaching command factory: ownership and returned contract", () => {
  it("waits for ownership before forwarding exact CAS/branch request once and validating the result", async () => {
    const gate = deferred(); io.owned.mockReturnValueOnce(gate.promise);
    const service = createOpeningTeachingCommandService(sql), pending = service.execute(scope, activityId, request);
    expect(io.owned).toHaveBeenCalledExactlyOnceWith(scope, activityId); expect(io.execute).not.toHaveBeenCalled();
    gate.resolve(); expect(await pending).toEqual(success());
    expect(io.execute).toHaveBeenCalledExactlyOnceWith(scope, activityId, request);
    expect(io.factory).toHaveBeenCalledExactlyOnceWith(sql);
  });
  it("does not execute when the deferred owner check rejects, including a well-shaped replay request", async () => {
    const gate = deferred(); io.owned.mockReturnValueOnce(gate.promise.then(() => { throw Object.assign(new Error("not owned"), { code: "NOT_FOUND" }); }));
    const pending = createOpeningTeachingCommandService(sql).execute(scope, activityId, request);
    const assertion = expect(pending).rejects.toMatchObject({ code: "NOT_FOUND", status: 404, message: "not owned" });
    gate.resolve(); await assertion; expect(io.execute).not.toHaveBeenCalled();
  });
  it("keeps independently pending ownership calls scoped to their own request on one factory", async () => {
    const first = deferred(), second = deferred(), otherScope = { ...scope, ownerUserId: id(8) }, otherActivity = id(9);
    io.owned.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const service = createOpeningTeachingCommandService(sql);
    const pendingFirst = service.execute(scope, activityId, request);
    const otherRequest = { ...request, clientKey: "second-command-key", expectedVersion: 3 };
    const pendingSecond = service.execute(otherScope, otherActivity, otherRequest);
    expect(io.execute).not.toHaveBeenCalled();
    io.execute.mockResolvedValueOnce({ ...success(), activityId: otherActivity });
    second.resolve(); expect(await pendingSecond).toMatchObject({ activityId: otherActivity });
    expect(io.execute).toHaveBeenCalledExactlyOnceWith(otherScope, otherActivity, otherRequest);
    first.resolve(); expect(await pendingFirst).toMatchObject({ activityId });
    expect(io.execute.mock.calls[1]).toEqual([scope, activityId, request]);
    expect(io.factory).toHaveBeenCalledOnce();
    // This is Promise/closure routing, not concurrent database transaction validation.
  });
  it("returns a valid structured conflict instead of throwing or coercing it into success", async () => {
    io.execute.mockResolvedValueOnce(conflict());
    expect(await createOpeningTeachingCommandService(sql).execute(scope, activityId, request)).toEqual(conflict());
    expect(io.execute).toHaveBeenCalledOnce();
  });
  it("preserves legitimate replay and assist fields without mutating the repository response", async () => {
    const result = { ...success(), kind: "why", replayed: true, assist: { kind: "why", summary: "Original explanation" } }, before = structuredClone(result);
    io.execute.mockResolvedValueOnce(result);
    expect(await createOpeningTeachingCommandService(sql).execute(scope, activityId, { ...request, kind: "why" })).toEqual(result);
    expect(result).toEqual(before);
  });
  it.each([
    ["missing replay flag", () => { const { replayed: _replayed, ...rest } = success(); return rest; }],
    ["nonpositive path version", () => ({ ...success(), pathVersion: 0 })],
    ["negative content version", () => ({ ...success(), contentVersion: -1 })],
    ["foreign result fields", () => ({ ...success(), answer: "uncontracted body" })],
    ["invalid assist kind", () => ({ ...success(), assist: { kind: "solution", summary: "body" } })],
    ["unknown conflict", () => ({ ...conflict(), conflict: "arbitrary" })],
    ["empty conflict message", () => ({ ...conflict(), message: "" })],
    ["empty lost block set", () => ({ ...conflict(), conflict: "draft_anchor_lost", lostBlockIds: [] })],
    ["foreign conflict fields", () => ({ ...conflict(), checkpointJson: {} })],
  ])("rejects malformed repository %s after exactly one execution", async (_label, make) => {
    io.execute.mockResolvedValueOnce(make());
    await expect(createOpeningTeachingCommandService(sql).execute(scope, activityId, request)).rejects.toMatchObject({ name: "ZodError" });
    expect(io.owned).toHaveBeenCalledOnce(); expect(io.execute).toHaveBeenCalledOnce();
  });
  it.each(["NOT_FOUND", "VALIDATION", "CONFLICT"])("maps %s from ownership without executing and from execution without retry", async code => {
    const status = code === "NOT_FOUND" ? 404 : code === "VALIDATION" ? 400 : 409;
    const error = Object.assign(new Error(`original ${code}`), { code });
    const service = createOpeningTeachingCommandService(sql);
    io.owned.mockRejectedValueOnce(error);
    await expect(service.execute(scope, activityId, request)).rejects.toMatchObject({ code, status, message: error.message });
    expect(io.execute).not.toHaveBeenCalled();
    io.execute.mockRejectedValueOnce(error);
    await expect(service.execute(scope, activityId, request)).rejects.toMatchObject({ code, status, message: error.message });
    expect(io.execute).toHaveBeenCalledOnce();
  });
  it.each([new Error("connection lost"), Object.assign(new Error("storage code"), { code: "ECONNRESET" }), null])("preserves unmapped execution failure identity: %j", async error => {
    io.execute.mockRejectedValueOnce(error);
    await expect(createOpeningTeachingCommandService(sql).execute(scope, activityId, request)).rejects.toBe(error);
    expect(io.execute).toHaveBeenCalledOnce();
  });
  it("allows the return command with no block while still checking ownership and request CAS", async () => {
    const raw = { clientKey: "return-boundary-key", kind: "return", expectedVersion: 0, expectedPathVersion: 2 };
    io.execute.mockResolvedValueOnce({ ...success(), kind: "return" });
    expect(await createOpeningTeachingCommandService(sql).execute(scope, activityId, raw)).toEqual({ ...success(), kind: "return" });
    expect(io.execute).toHaveBeenCalledExactlyOnceWith(scope, activityId, raw);
  });
  it("does not touch ownership or execution when request parsing fails", async () => {
    const service = createOpeningTeachingCommandService(sql);
    await expect(service.execute(scope, activityId, { ...request, expectedVersion: -1 })).rejects.toMatchObject({ name: "ZodError" });
    expect(io.owned).not.toHaveBeenCalled(); expect(io.execute).not.toHaveBeenCalled();
  });
});
