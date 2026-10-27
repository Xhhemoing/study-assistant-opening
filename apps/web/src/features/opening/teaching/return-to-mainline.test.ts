import { expect, it, vi } from "vitest";
import type { OpeningApi } from "../client/api";
import { returnToMainline } from "./return-to-mainline";

it("does not accept or send another command after the owning workspace unmounts", async () => {
  let resolve!: (value: unknown) => void;
  let mounted = true;
  const command = vi.fn(() => new Promise(done => { resolve = done; }));
  const accept = vi.fn(() => true);
  const pending = returnToMainline({ api: { postTeachingCommand: command } as unknown as OpeningApi, activityId: "activity", contentVersion: 2, pathVersion: 4,
    checkpoint: { branchStack: [{}, {}] }, accept, isCurrent: () => mounted });
  mounted = false;
  resolve({ ok: true, contentVersion: 2, pathVersion: 5, checkpointJson: { branchStack: [{}] } });
  await pending;
  expect(command).toHaveBeenCalledOnce(); expect(accept).not.toHaveBeenCalled();
});

it("unwinds old branches with each confirmed path version and no rewrite command", async () => {
  const command = vi.fn().mockResolvedValueOnce({ ok: true, contentVersion: 2, pathVersion: 5, checkpointJson: { branchStack: [{}] } })
    .mockResolvedValueOnce({ ok: true, contentVersion: 2, pathVersion: 6, checkpointJson: { branchStack: [] } });
  const accept = vi.fn(() => true);
  await returnToMainline({ api: { postTeachingCommand: command } as unknown as OpeningApi, activityId: "activity", contentVersion: 2, pathVersion: 4, checkpoint: { branchStack: [{}, {}] }, accept });
  expect(command.mock.calls.map(call => call[1])).toEqual([
    { kind: "return", expectedVersion: 2, expectedPathVersion: 4, clientKey: expect.any(String) },
    { kind: "return", expectedVersion: 2, expectedPathVersion: 5, clientKey: expect.any(String) },
  ]);
  expect(accept).toHaveBeenCalledTimes(2);
});

it("stops on a rejected snapshot, conflict or unknown result without retrying", async () => {
  const success = { ok: true, contentVersion: 2, pathVersion: 5, checkpointJson: { branchStack: [{}] } };
  const command = vi.fn().mockResolvedValue(success);
  await returnToMainline({ api: { postTeachingCommand: command } as unknown as OpeningApi, activityId: "activity", contentVersion: 2, pathVersion: 4, checkpoint: { branchStack: [{}, {}] }, accept: () => false });
  expect(command).toHaveBeenCalledOnce();
  command.mockReset().mockResolvedValue({ ok: false, conflict: "stale_path_version" });
  const conflict = vi.fn();
  await returnToMainline({ api: { postTeachingCommand: command } as unknown as OpeningApi, activityId: "activity", contentVersion: 2, pathVersion: 4, checkpoint: { branchStack: [{}] }, accept: () => true, onConflict: conflict });
  expect(command).toHaveBeenCalledOnce(); expect(conflict).toHaveBeenCalledOnce();
  command.mockReset().mockRejectedValue(new Error("unknown network result"));
  await expect(returnToMainline({ api: { postTeachingCommand: command } as unknown as OpeningApi, activityId: "activity", contentVersion: 2, pathVersion: 4, checkpoint: { branchStack: [{}] }, accept: () => true })).rejects.toThrow("unknown network result");
  expect(command).toHaveBeenCalledOnce();
});
