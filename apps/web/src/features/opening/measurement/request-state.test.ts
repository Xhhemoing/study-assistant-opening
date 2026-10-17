import { describe, expect, it } from "vitest";
import { createMeasurementRequestState } from "./request-state";

describe("measurement request ownership", () => {
  it("requires an actual successful read for the course before allowing a write", () => {
    const requests = createMeasurementRequestState();
    expect(requests.beginRead()).toBeNull();
    requests.activate();
    expect(requests.beginWrite("course")).toBeNull();
    const failedRead = requests.beginRead()!;
    requests.finish(failedRead, null);
    expect(requests.beginWrite("course")).toBeNull();
    const read = requests.beginRead()!;
    requests.finish(read, "course");
    expect(requests.beginWrite("other-course")).toBeNull();
    expect(requests.beginWrite("course")).not.toBeNull();
  });

  it("serializes reads and writes synchronously and requires a new read after an uncertain write", () => {
    const requests = createMeasurementRequestState();
    requests.activate();
    const read = requests.beginRead()!;
    expect(requests.beginRead()).toBeNull();
    expect(requests.beginWrite("course")).toBeNull();
    requests.finish(read, "course");
    const write = requests.beginWrite("course")!;
    expect(requests.beginWrite("course")).toBeNull();
    expect(requests.beginRead()).toBeNull();
    requests.finish(write, null);
    expect(requests.beginWrite("course")).toBeNull();
    const recovery = requests.beginRead()!;
    requests.finish(recovery, "course");
    expect(requests.beginWrite("course")).not.toBeNull();
  });

  it("cannot let a late response unlock or overwrite a replacement lifecycle request", () => {
    const requests = createMeasurementRequestState();
    requests.activate();
    const oldRead = requests.beginRead()!;
    requests.invalidate();
    requests.activate();
    const newRead = requests.beginRead()!;
    expect(requests.current(oldRead)).toBe(false);
    expect(requests.finish(oldRead, "old-course")).toBe(false);
    expect(requests.current(newRead)).toBe(true);
    expect(requests.beginWrite("old-course")).toBeNull();
    requests.finish(newRead, "new-course");
    const write = requests.beginWrite("new-course")!;
    requests.invalidate();
    expect(requests.current(write)).toBe(false);
    expect(requests.finish(write, "new-course")).toBe(false);
    expect(requests.beginWrite("new-course")).toBeNull();
  });
});
