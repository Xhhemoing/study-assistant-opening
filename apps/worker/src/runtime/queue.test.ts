import { describe, expect, it, vi } from "vitest";

vi.mock("bullmq", () => ({
  Queue: class MockQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
  },
}));

import { createQueues } from "./queue";

describe("createQueues", () => {
  it("includes extract-study-actions so outbox jobs of that kind are consumed", () => {
    const queues = createQueues({} as never);
    expect(Object.keys(queues).sort()).toEqual([
      "build-course-knowledge",
      "extract-study-actions",
      "parse",
      "parse-media",
      "remind",
      "retest",
      "tutor",
    ]);
    expect(queues["extract-study-actions"].name).toBe("opening-extract-study-actions");
  });
});
