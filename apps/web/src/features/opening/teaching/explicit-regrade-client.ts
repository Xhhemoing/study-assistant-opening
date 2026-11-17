import {
  EXPLICIT_REGRADE_CONFIRMATION_VERSION,
  type AiGradingStatus,
  type ExplicitRegradeConfirm,
  type ExplicitRegradePrepare,
  type ExplicitRegradeRequest,
} from "@aistudy/contracts";

/** Owner supplies a fresh, authenticated snapshot; never infer versions from UI history. */
export type ExplicitRegradeSnapshot = {
  rootObservationId: string;
  expectedHead: string;
  answerRevision: number;
  privacyEpoch: number;
  previousGradingVersion: number;
  /** Changes on parent reread/navigation, even when the head has not changed. */
  epoch: number;
  oldStatus: AiGradingStatus["status"];
};

export type ExplicitRegradeProgress = {
  request: ExplicitRegradeRequest;
  /** Consent persistence alone is NOT an enqueued or paid job. */
  status: AiGradingStatus | null;
};
type Conflict = { kind: "conflict" };
export type ExplicitRegradePrepared = { kind: "prepared"; request: ExplicitRegradeRequest; estimate: string | null };
export type ExplicitRegradeRead = { kind: "progress"; progress: ExplicitRegradeProgress };

/**
 * Injection boundary, NOT an HTTP implementation. The HTTP owner must parse responses,
 * map head/privacy/version conflicts, and provide a policy-backed price estimate.
 * prepare only captures consent; confirm admits the server-owned request/version using
 * requestId idempotency. read MUST be read-only, including recovery by clientKey when
 * prepare's response was lost. It must not reserve, enqueue, confirm or invoke a model.
 */
export type ExplicitRegradeAdapter = {
  prepare(input: ExplicitRegradePrepare): Promise<ExplicitRegradePrepared | ExplicitRegradeRead | Conflict>;
  confirm(input: ExplicitRegradeConfirm): Promise<ExplicitRegradeRead | Conflict>;
  read(input: { observationId: string; clientKey: string; requestId: string | null }): Promise<ExplicitRegradeRead | ExplicitRegradePrepared | Conflict>;
};

export type ExplicitRegradeState = {
  phase: "idle" | "preparing" | "prepared" | "confirming" | "confirmed" | "pending" | "graded" | "unknown" | "manual" | "unconfirmed" | "conflict";
  request?: ExplicitRegradeRequest;
  estimate?: string | null;
  status?: AiGradingStatus | null;
  reading?: boolean;
  readFailed?: boolean;
  confirmAttempted?: boolean;
};

function snapshotKey(snapshot: ExplicitRegradeSnapshot) {
  return [snapshot.rootObservationId, snapshot.expectedHead, snapshot.answerRevision,
    snapshot.privacyEpoch, snapshot.previousGradingVersion].join(":");
}

function prepareInput(snapshot: ExplicitRegradeSnapshot): ExplicitRegradePrepare {
  return {
    observationId: snapshot.expectedHead,
    expectedHead: snapshot.expectedHead,
    expectedGradingVersion: snapshot.previousGradingVersion,
    // Stable across UI replay. Server allocates requestId, operationId and gradingVersion.
    clientKey: `explicit-regrade:${snapshot.rootObservationId}:${snapshot.expectedHead}:${snapshot.answerRevision}:${snapshot.privacyEpoch}:${snapshot.previousGradingVersion}`,
  };
}

function samePhoto(a: ExplicitRegradeRequest["workSource"], b: ExplicitRegradeRequest["workSource"]) {
  return a?.id === b?.id && a?.version === b?.version && a?.physicalPage === b?.physicalPage;
}

function matches(snapshot: ExplicitRegradeSnapshot, request: ExplicitRegradeRequest) {
  return request.rootObservationId === snapshot.rootObservationId && request.expectedHead === snapshot.expectedHead
    && request.answerRevision === snapshot.answerRevision && request.privacyEpoch === snapshot.privacyEpoch
    && request.previousGradingVersion === snapshot.previousGradingVersion
    && request.gradingVersion === snapshot.previousGradingVersion + 1
    && request.operationId !== request.previousOperationId;
}

/**
 * Create once per authenticated owner/tab, retain across component remounts, discard
 * on account/workspace switch. No global cache or localStorage containing paid inputs.
 * isCurrent must read the owner's live head/privacy/version/epoch, not a captured prop.
 * A synchronous state transition locks clicks before React commits a disabled button.
 */
export function createExplicitRegradeSession(adapter: ExplicitRegradeAdapter, isCurrent: (snapshot: ExplicitRegradeSnapshot) => boolean) {
  const states = new Map<string, { epoch: number; state: ExplicitRegradeState }>();
  const listeners = new Set<() => void>();
  const idle: ExplicitRegradeState = { phase: "idle" };
  const stale: ExplicitRegradeState = { phase: "conflict" };
  const get = (snapshot: ExplicitRegradeSnapshot) => {
    const entry = states.get(snapshotKey(snapshot));
    return !entry ? idle : entry.epoch === snapshot.epoch ? entry.state : stale;
  };
  const set = (snapshot: ExplicitRegradeSnapshot, state: ExplicitRegradeState) => {
    const key = snapshotKey(snapshot);
    if (states.has(key) && states.get(key)!.epoch !== snapshot.epoch) return;
    states.set(key, { epoch: snapshot.epoch, state });
    listeners.forEach(listener => listener());
  };
  function accept(snapshot: ExplicitRegradeSnapshot, result: ExplicitRegradeRead | ExplicitRegradePrepared | Conflict) {
    const previous = get(snapshot);
    if (!isCurrent(snapshot)) { set(snapshot, { ...previous, phase: "conflict", reading: false }); return; }
    if (result.kind === "conflict") { set(snapshot, { ...previous, phase: "conflict", reading: false }); return; }
    const request = result.kind === "prepared" ? result.request : result.progress.request;
    if (!matches(snapshot, request) || previous.request && (previous.request.requestId !== request.requestId
      || previous.request.operationId !== request.operationId || previous.request.previousOperationId !== request.previousOperationId
      || !samePhoto(previous.request.workSource, request.workSource))) {
      set(snapshot, { ...previous, phase: "conflict", reading: false }); return;
    }
    if (result.kind === "prepared") {
      set(snapshot, { ...previous, phase: request.state === "prepared" ? previous.confirmAttempted ? "unconfirmed" : "prepared" : "confirmed",
        request, estimate: result.estimate, reading: false, readFailed: false }); return;
    }
    const status = result.progress.status;
    if (status && (status.rootObservationId !== snapshot.rootObservationId || status.answerRevision !== snapshot.answerRevision
      || (status.status === "graded" ? !request.resultObservationId || status.headObservationId !== request.resultObservationId
        : status.headObservationId !== snapshot.expectedHead)
      || status.jobId !== request.jobId || !samePhoto(status.workSource, request.workSource))) {
      set(snapshot, { ...previous, phase: "conflict", reading: false }); return;
    }
    const phase = request.state !== "confirmed" ? "unconfirmed"
      : !status ? "confirmed" : status.status === "unknown_cost" ? "unknown"
        : status.status === "graded" ? "graded" : status.status === "needs_manual" ? "manual"
          : status.jobId ? "pending" : "confirmed";
    set(snapshot, { ...previous, phase, request, status, reading: false, readFailed: false });
  }
  return {
    get,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async prepare(snapshot: ExplicitRegradeSnapshot) {
      if (!isCurrent(snapshot) || snapshot.oldStatus !== "unknown_cost" || get(snapshot).phase !== "idle") return;
      set(snapshot, { phase: "preparing" });
      try { accept(snapshot, await adapter.prepare(prepareInput(snapshot))); }
      catch { set(snapshot, { ...get(snapshot), phase: "unconfirmed" }); }
    },
    async confirm(snapshot: ExplicitRegradeSnapshot) {
      const previous = get(snapshot);
      if (!isCurrent(snapshot) || snapshot.oldStatus !== "unknown_cost" || previous.phase !== "prepared" || !previous.estimate?.trim() || !previous.request) return;
      set(snapshot, { ...previous, phase: "confirming", confirmAttempted: true });
      try {
        accept(snapshot, await adapter.confirm({ requestId: previous.request.requestId,
          confirmationVersion: EXPLICIT_REGRADE_CONFIRMATION_VERSION, acceptPossibleDoubleCharge: true }));
      } catch { set(snapshot, { ...previous, phase: "unconfirmed", confirmAttempted: true }); }
    },
    async read(snapshot: ExplicitRegradeSnapshot) {
      const previous = get(snapshot);
      if (!isCurrent(snapshot) || ["idle", "preparing", "confirming"].includes(previous.phase) || previous.reading) return;
      // A fresh owner snapshot may recover by GET, never by replaying a paid POST.
      const key = snapshotKey(snapshot);
      const entry = states.get(key);
      if (entry && entry.epoch !== snapshot.epoch) {
        states.set(key, { epoch: snapshot.epoch, state: { ...entry.state, phase: "conflict" } });
      }
      set(snapshot, { ...get(snapshot), reading: true, readFailed: false });
      try {
        accept(snapshot, await adapter.read({ observationId: snapshot.expectedHead,
          clientKey: prepareInput(snapshot).clientKey, requestId: previous.request?.requestId ?? null }));
      } catch { set(snapshot, { ...get(snapshot), reading: false, readFailed: true }); }
    },
  };
}

export type ExplicitRegradeOwner = {
  /** Latest server head/version/status; a result status must never overwrite this head. */
  snapshot: ExplicitRegradeSnapshot;
  /** Captured paid-input identity for the operation being displayed/recovered. */
  operationSnapshot?: ExplicitRegradeSnapshot;
  session: ReturnType<typeof createExplicitRegradeSession>;
};
