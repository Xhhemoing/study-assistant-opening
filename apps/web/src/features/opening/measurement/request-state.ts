type MeasurementRequest = { kind: "read" | "write" };

/** Synchronous ownership also covers clicks before React renders a pending state. */
export function createMeasurementRequestState() {
  let active = false;
  let pending: MeasurementRequest | null = null;
  let readableCourseId: string | null = null;

  function current(request: MeasurementRequest) {
    return active && pending === request;
  }

  return {
    activate() { active = true; pending = null; readableCourseId = null; },
    invalidate() { active = false; pending = null; readableCourseId = null; },
    beginRead(): MeasurementRequest | null {
      if (!active || pending) return null;
      readableCourseId = null;
      return pending = { kind: "read" };
    },
    beginWrite(courseId: string): MeasurementRequest | null {
      if (!active || pending || readableCourseId !== courseId) return null;
      return pending = { kind: "write" };
    },
    current,
    finish(request: MeasurementRequest, confirmedCourseId: string | null) {
      if (!current(request)) return false;
      pending = null;
      readableCourseId = confirmedCourseId;
      return true;
    },
  };
}
