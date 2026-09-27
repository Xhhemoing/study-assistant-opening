import { expect, it, vi } from "vitest";
import { createOpeningLearningClient } from "./learning-client";

const COURSE = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

it("does not fill a failed backend with demo learning results", async () => {
  const client = createOpeningLearningClient(async () => new Response("unavailable", { status: 503 }));
  await expect(client.getSummary(COURSE)).rejects.toThrow();
});

it("rejects submitObservation when the backend is unavailable", async () => {
  const client = createOpeningLearningClient(async () => new Response("unavailable", { status: 503 }));
  await expect(client.submitObservation({
    sessionId: SESSION,
    courseId: COURSE,
    skillLabel: "fractions",
    sourceIds: [],
    answer: "1/2",
    outcome: "unverified",
    assistance: "unknown",
    clientKey: "client-key-01",
  })).rejects.toThrow();
});

it("parses a genuine empty summary without inventing skills", async () => {
  const fetchImpl = vi.fn(async (url: string) => {
    expect(url).toBe(`/api/opening/courses/${COURSE}/learning`);
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = createOpeningLearningClient(fetchImpl as unknown as typeof fetch);
  await expect(client.getSummary(COURSE)).resolves.toEqual([]);
});
