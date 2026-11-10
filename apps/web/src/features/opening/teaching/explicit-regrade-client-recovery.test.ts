import { expect, it, vi } from "vitest";
import { EXPLICIT_REGRADE_CONFIRMATION_TEXT, EXPLICIT_REGRADE_CONFIRMATION_VERSION,
  type ExplicitRegradePrepare, type ExplicitRegradeRequest } from "@aistudy/contracts";
import { createExplicitRegradeSession, type ExplicitRegradeAdapter, type ExplicitRegradeSnapshot } from "./explicit-regrade-client";

it("recovers a lost prepare response by stable clientKey without replaying prepare or confirming on reads", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const snapshot: ExplicitRegradeSnapshot = { rootObservationId: id, expectedHead: id, answerRevision: 1,
    privacyEpoch: 2, previousGradingVersion: 0, epoch: 1, oldStatus: "unknown_cost" };
  const request: ExplicitRegradeRequest = { requestId: "22222222-2222-4222-8222-222222222222",
    rootObservationId: id, expectedHead: id, answerRevision: 1, privacyEpoch: 2, previousGradingVersion: 0,
    gradingVersion: 1, previousOperationId: "historical-unknown", operationId: "ai-regrade:synthetic:new",
    confirmationVersion: EXPLICIT_REGRADE_CONFIRMATION_VERSION, confirmationText: EXPLICIT_REGRADE_CONFIRMATION_TEXT,
    workSource: null, state: "prepared", confirmedAt: null, jobId: null, resultObservationId: null };
  let captured: ExplicitRegradePrepare | undefined;
  // Adapter is deliberately injected: this test does NOT implement or assert any HTTP route.
  const prepare = vi.fn<ExplicitRegradeAdapter["prepare"]>(async input => {
    captured = input; throw new Error("synthetic response lost after persistence");
  });
  const read = vi.fn<ExplicitRegradeAdapter["read"]>(async input => {
    expect(input).toEqual({ observationId: captured!.observationId, clientKey: captured!.clientKey, requestId: null });
    return { kind: "prepared", request, estimate: "synthetic estimate" };
  });
  const confirm = vi.fn<ExplicitRegradeAdapter["confirm"]>();
  const session = createExplicitRegradeSession({ prepare, read, confirm }, () => true);
  await session.prepare(snapshot);
  expect(session.get(snapshot).phase).toBe("unconfirmed");
  await Promise.all([session.read(snapshot), session.read(snapshot)]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(session.get(snapshot)).toMatchObject({ phase: "prepared", request });
  await session.prepare(snapshot); // Remount/replay must not send another prepare.
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();
  expect(captured!.clientKey).toBe(`explicit-regrade:${id}:${id}:1:2:0`);
  confirm.mockRejectedValueOnce(new Error("synthetic lost confirm response"));
  await session.confirm(snapshot);
  expect(session.get(snapshot)).toMatchObject({ phase: "unconfirmed", confirmAttempted: true });
  read.mockImplementation(async input => {
    expect(input).toEqual({ observationId: id, clientKey: captured!.clientKey, requestId: request.requestId });
    return { kind: "prepared", request, estimate: "synthetic estimate" };
  });
  await session.read(snapshot);
  await session.confirm(snapshot);
  await session.prepare(snapshot);
  expect(session.get(snapshot).phase).toBe("unconfirmed");
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(2);
});
