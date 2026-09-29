import { describe, expect, it } from "vitest";
import { candidateRefSchema, reviewResultSchema } from "./candidate-review";
import { taskCreateInputSchema, taskCreateResultSchema, taskItemSchema } from "./planning";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const task = { title: "复习", minutes: 20, dueAt: null, priority: 1, candidateId: id };
const snapshot = { kind: "retest", candidateId: id, heuristic: true };

describe("source-aware candidate review contracts", () => {
  it.each([
    { origin: "assistant", kind: "task", id },
    { origin: "assistant", kind: "memory", id },
    { origin: "retest", kind: "retest", id },
  ])("retains the joint identity %j", (ref) => {
    expect(candidateRefSchema.parse(ref)).toEqual(ref);
  });

  it.each([
    { origin: "assistant", kind: "retest", id },
    { origin: "retest", kind: "task", id },
    { origin: "retest", kind: "memory", id },
    { origin: "assistant", kind: "task", id: "not-a-uuid" },
  ])("rejects a mixed or invalid identity %j", (ref) => {
    expect(candidateRefSchema.safeParse(ref).success).toBe(false);
  });

  it("keeps old manual and assistant task requests compatible", () => {
    expect(taskCreateInputSchema.parse(task)).toEqual(task);
    expect(taskCreateInputSchema.parse({ ...task, candidateId: null }).candidateId).toBeNull();
    expect(taskCreateInputSchema.parse({ ...task, inputSnapshot: snapshot }).inputSnapshot).toEqual(snapshot);
  });

  it("accepts a matching assistant or retest reference", () => {
    const assistant = { ...task, candidateRef: { origin: "assistant", kind: "task", id } };
    const retest = { ...task, candidateRef: { origin: "retest", kind: "retest", id }, inputSnapshot: snapshot };
    expect(taskCreateInputSchema.parse(assistant)).toEqual(assistant);
    expect(taskCreateInputSchema.parse(retest)).toEqual(retest);
  });

  it.each([
    { candidateRef: { origin: "assistant", kind: "memory", id } },
    { candidateRef: { origin: "assistant", kind: "task", id: otherId } },
    { candidateRef: { origin: "retest", kind: "retest", id } },
    { candidateRef: { origin: "assistant", kind: "task", id }, inputSnapshot: snapshot },
    { candidateId: null, inputSnapshot: snapshot },
    { inputSnapshot: { ...snapshot, candidateId: otherId } },
  ])("rejects inconsistent task command identity %j", (overrides) => {
    expect(taskCreateInputSchema.safeParse({ ...task, ...overrides }).success).toBe(false);
  });

  it("represents a replay without duplicating the created object", () => {
    const result = { disposition: "replayed", resultRef: { kind: "task", id } };
    expect(reviewResultSchema.parse(result)).toEqual(result);
    expect(reviewResultSchema.parse({ disposition: "already_processed", resultRef: null }).resultRef).toBeNull();
  });
});

it("accepts optional original versions and rejects malformed keys or versions", () => {
  const input = { ...task, clientKey: "retry-key", expectedVersion: 0 };
  expect(taskCreateInputSchema.parse(input)).toEqual(input);
  for (const bad of [{ expectedVersion: -1 }, { expectedVersion: 0.5 }, { clientKey: "short" }]) {
    expect(taskCreateInputSchema.safeParse({ ...input, ...bad }).success).toBe(false);
  }
});

it("retains the legacy task shape while exposing review metadata for explicit clients", () => {
  const created = { id, title: "复习", minutes: 20, dueAt: null, priority: 1, status: "pending" };
  expect(taskItemSchema.parse(created)).toEqual(taskCreateResultSchema.parse(created));
  for (const disposition of ["applied", "replayed", "already_processed"]) {
    const response = { ...created, reviewResult: { disposition, resultRef: { kind: "task", id } } };
    expect(taskCreateResultSchema.parse(response)).toEqual(response);
  }
});
