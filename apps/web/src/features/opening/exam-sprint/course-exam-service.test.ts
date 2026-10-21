import { beforeEach, expect, it, vi } from "vitest";
import { BudgetReplayError, type ModelGateway } from "@aistudy/ai";
import type { CourseExamProposal } from "@aistudy/contracts";
import { createCourseExamService } from "./course-exam-service";

const id = "11111111-1111-4111-8111-111111111111", scope = { workspaceId: id, ownerUserId: id };
const input = { clientKey: "test-request-1", sourceId: id, questionCount: 3 };
const proposal: CourseExamProposal = { title: "Mock", topics: [{ label: "Topic", evidenceChunkIds: [id] }],
  questions: Array.from({ length: 3 }, () => ({ topic: "Topic", prompt: "A complete question with all its conditions.", referenceAnswer: "server-only answer",
    rubric: ["criterion"], hints: { direction: "direction", concept: "concept", firstStep: "step" }, evidenceChunkIds: [id], estimatedMinutes: 5 })) };
type Options = Parameters<ModelGateway["call"]>[2];
const repository = { read: vi.fn(), begin: vi.fn(), assertCurrent: vi.fn(), complete: vi.fn(), fail: vi.fn() };
const call = vi.fn();
const service = createCourseExamService({ repository, gateway: { call }, budget: () => ({} as Options["budget"]) });
let status: "pending" | "ready" | "failed" | "unknown";
const output = { text: JSON.stringify(proposal), inputTokens: 10, outputTokens: 20, requestId: "receipt", candidates: [], citedChunkIds: [] };

beforeEach(() => {
  vi.resetAllMocks(); status = "pending";
  repository.begin.mockImplementation(async () => ({ courseTitle: "Course", chunks: [], request: { id, sourceTitle: "Paper", status } }));
  repository.read.mockImplementation(async () => ({ papers: [{ id, status }] }));
  repository.complete.mockImplementation(async () => { status = "ready"; return id; });
  repository.fail.mockImplementation(async (_scope, _courseId, _id, value) => { status = value; });
  call.mockImplementation(async (_scope, _task, options: Options) => {
    await options.beforeSend?.(); await options.persistResult?.(output, { reservationId: "r", settledCents: 1 }); return output;
  });
});

it("uses the shared gateway ledger and publishes before returning the course result", async () => {
  expect((await service.generate(scope, id, input)).papers[0]).toMatchObject({ status: "ready" });
  const options = call.mock.calls[0]![2] as Options;
  expect(call.mock.calls[0]![1]).toBe("practice.exam");
  expect(options.operationId).toBe(`course-exam:${id}:${id}`);
  expect(options.input.text).toContain("3 题");
  expect(repository.assertCurrent).toHaveBeenCalledWith(scope, id, id);
  expect(repository.complete).toHaveBeenCalledWith(scope, id, id, proposal, null);
});

it.each(["ready", "failed", "unknown"] as const)("does not resend a %s request", async value => {
  status = value;
  await service.generate(scope, id, input);
  expect(call).not.toHaveBeenCalled();
});

it("preserves an in-flight request without converting it to failure", async () => {
  call.mockRejectedValueOnce(new BudgetReplayError({ kind: "in_flight", reservationId: "r" }));
  expect((await service.generate(scope, id, input)).papers[0]!.status).toBe("pending");
  expect(repository.fail).not.toHaveBeenCalled();
});

it("never republishes or fails a stored paper when settlement fails", async () => {
  call.mockImplementation(async (_scope, _task, options: Options) => {
    await options.beforeSend?.(); await options.persistResult?.(output, { reservationId: "r", settledCents: 1 }); throw new Error("settlement interrupted");
  });
  expect((await service.generate(scope, id, input)).papers[0]!.status).toBe("ready");
  expect(repository.fail).not.toHaveBeenCalled();
});

it("does not transmit after a privacy refusal and distinguishes a sent malformed answer", async () => {
  repository.assertCurrent.mockRejectedValueOnce(new Error("private"));
  await expect(service.generate(scope, id, input)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(status).toBe("failed"); expect(repository.complete).not.toHaveBeenCalled();
  status = "pending";
  call.mockImplementation(async (_scope, _task, options: Options) => {
    await options.beforeSend?.(); await options.persistResult?.({ ...output, text: "not JSON" }, { reservationId: "r", settledCents: 1 }); return output;
  });
  await expect(service.generate(scope, id, input)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(status).toBe("unknown"); expect(repository.complete).not.toHaveBeenCalled();
});

it("does not relabel an unknown previous charge as an unsent request", async () => {
  call.mockRejectedValueOnce(new BudgetReplayError({ kind: "unknown", reservationId: "r", pendingReconcileCents: 0, reconciled: false }));
  await expect(service.generate(scope, id, input)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(status).toBe("unknown");
});

it("rejects missing hint content before publishing a usable mock", async () => {
  const malformed = structuredClone(proposal); malformed.questions[0]!.hints.direction = "  ";
  call.mockImplementation(async (_scope, _task, options: Options) => {
    await options.beforeSend?.(); await options.persistResult?.({ ...output, text: JSON.stringify(malformed) }, { reservationId: "r", settledCents: 1 }); return output;
  });
  await expect(service.generate(scope, id, input)).rejects.toMatchObject({ code: "CONFLICT" });
  expect(repository.complete).not.toHaveBeenCalled(); expect(status).toBe("unknown");
});
