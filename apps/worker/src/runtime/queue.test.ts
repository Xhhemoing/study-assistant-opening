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
      "compile-teaching-unit",
      "extract-study-actions",
      "grade-observation",
      "index-source",
      "parse",
      "parse-media",
      "recognize-photo-question",
      "remind",
      "retest",
      "tutor",
      "tutor-metadata",
    ]);
    expect(queues["extract-study-actions"].name).toBe("opening-extract-study-actions");
  });

  it("includes compile-teaching-unit for V2-07 teaching generation", () => {
    const queues = createQueues({} as never);
    expect(queues["compile-teaching-unit"].name).toBe("opening-compile-teaching-unit");
  });
});
