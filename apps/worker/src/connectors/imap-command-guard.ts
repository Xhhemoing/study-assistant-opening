export const MAX_IMAP_LINE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAP_LITERAL_BYTES = 26 * 1024 * 1024;
export const MAX_IMAP_RESPONSE_BYTES = 28 * 1024 * 1024;
export const MAX_IMAP_FETCH_COMMAND_BYTES = MAX_IMAP_RESPONSE_BYTES + 64 * 1024;
export const MAX_IMAP_PROBE_COMMAND_BYTES = 64 * 1024;
export const MAX_IMAP_CONTROL_COMMAND_BYTES = MAX_IMAP_RESPONSE_BYTES + 64 * 1024;

export type ImapCommandGuardLimits = {
  maxFetchCommandBytes?: number;
  maxProbeCommandBytes?: number;
  maxControlCommandBytes?: number;
};

export type ImapFetchGuardSpec = {
  maxBytes: number;
  maxFetchResponses?: number;
  expectedUid?: number;
  isProbe?: boolean;
};

type ErrorEventClient = {
  on?: (event: string, listener: (error: unknown) => void) => unknown;
  close?: () => void;
};

export type ClientErrorState = {
  firstError: Error | null;
  waiters: Set<(error: Error) => void>;
};

const clientErrorStates = new WeakMap<object, ClientErrorState>();

/** Return canonical partial-offset key recorded on FetchMessageObject.bodyParts. */
export function partialBodyOffsetKey(offset: number): string {
  return `BODY[]<${offset}>`;
}

/** Record the first transport/guard failure on a client and wake any deadline waiter. */
export function recordClientError(client: object, err: Error): void {
  const state = clientErrorStates.get(client);
  if (!state) return;
  if (!state.firstError) state.firstError = err;
  try {
    (client as ErrorEventClient).close?.();
  } catch {
    // Ignore socket teardown errors after recording the original client failure.
  }
  for (const reject of state.waiters) reject(state.firstError);
  state.waiters.clear();
}

export function getClientErrorState(client: object): ClientErrorState | undefined {
  return clientErrorStates.get(client);
}

/** Attach a persistent 'error' listener once per client so wire/socket errors never crash Node. */
export function attachImapClientErrorGuard<T extends object>(client: T): T {
  if (clientErrorStates.has(client)) return client;
  const state: ClientErrorState = { firstError: null, waiters: new Set() };
  clientErrorStates.set(client, state);
  const emitter = client as ErrorEventClient;
  if (typeof emitter.on === "function") {
    emitter.on("error", (err: unknown) => {
      const normalized = err instanceof Error ? err : new Error(String(err));
      recordClientError(client, normalized);
    });
  }
  return client;
}

type CapturedBodySections = {
  valid: boolean;
  parts: Map<string, Buffer>;
};

type ActiveCommandGuard = {
  maxBytes: number;
  maxFetchResponses?: number;
  expectedUid?: number;
  wireBytes: number;
  streamBytes: number;
  untaggedFetchCount: number;
  failed: Error | null;
  reject: (error: Error) => void;
};

type CommandGuardState = {
  limits: Required<ImapCommandGuardLimits>;
  activeGuard: ActiveCommandGuard | null;
  pendingFetchSpec: ImapFetchGuardSpec | null;
  lastFetchBodySections: CapturedBodySections | null;
  meteredSocket: { removeListener?: (event: string, fn: (...args: unknown[]) => void) => unknown } | null;
};

const commandGuardStates = new WeakMap<object, CommandGuardState>();

const BOUNDED_CONTROL_COMMANDS = new Set([
  "SELECT",
  "EXAMINE",
  "SEARCH",
  "UID SEARCH",
  "LIST",
  "LSUB",
  "NAMESPACE",
  "CAPABILITY",
  "ID",
  "ENABLE",
  "LOGOUT",
  "STATUS",
  "STARTTLS",
  "LOGIN",
  "AUTHENTICATE",
]);

function chunkByteLength(chunk: unknown): number {
  if (Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)) {
    return chunk.byteLength;
  }
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk, "utf8");
  }
  return 0;
}

type ParsedAttrNode = {
  type?: unknown;
  value?: unknown;
  section?: unknown;
  partial?: unknown;
} | null | undefined;

function inspectFetchUntagged(untagged: unknown): {
  uid: number | undefined;
  bodySections: CapturedBodySections;
} {
  const list = (untagged as { attributes?: unknown[] } | null)?.attributes?.[1];
  const parts = new Map<string, Buffer>();
  if (!Array.isArray(list)) {
    return { uid: undefined, bodySections: { valid: false, parts } };
  }
  let uid: number | undefined;
  let valid = true;
  let bodySectionCount = 0;
  for (let i = 0; i + 1 < list.length; i += 2) {
    const attrKey = list[i] as ParsedAttrNode;
    const attrVal = list[i + 1] as ParsedAttrNode;
    const keyName = typeof attrKey?.value === "string" ? attrKey.value.toUpperCase() : "";
    if (keyName === "UID" && !attrKey?.section) {
      const rawUid = typeof attrVal?.value === "string" || typeof attrVal?.value === "number"
        ? String(attrVal.value)
        : "";
      if (/^\d{1,10}$/.test(rawUid)) {
        const parsedUid = Number(rawUid);
        if (parsedUid > 0 && Number.isSafeInteger(parsedUid)) uid = parsedUid;
      }
      continue;
    }
    if (keyName === "BODY" && Array.isArray(attrKey?.section) && attrKey.section.length === 0) {
      bodySectionCount += 1;
      if (bodySectionCount > 1) {
        valid = false;
        continue;
      }
      let buf: Buffer | null = null;
      if (attrVal && Buffer.isBuffer(attrVal.value)) {
        buf = attrVal.value;
      } else if (attrVal && typeof attrVal.value === "string") {
        buf = Buffer.from(attrVal.value, "utf8");
      }
      if (!buf) {
        valid = false;
        continue;
      }
      if (attrKey.partial === undefined) {
        parts.set("BODY[]", buf);
      } else if (
        Array.isArray(attrKey.partial)
        && attrKey.partial.length === 1
        && typeof attrKey.partial[0] === "number"
        && Number.isSafeInteger(attrKey.partial[0])
        && attrKey.partial[0] >= 0
      ) {
        parts.set(partialBodyOffsetKey(attrKey.partial[0]), buf);
      } else {
        valid = false;
      }
    }
  }
  return { uid, bodySections: { valid, parts } };
}

function failActiveGuard(state: CommandGuardState, client: object, err: Error): void {
  const guard = state.activeGuard;
  if (guard && !guard.failed) {
    guard.failed = err;
    recordClientError(client, err);
    guard.reject(err);
  } else {
    recordClientError(client, err);
  }
  try {
    (client as { close?: () => void }).close?.();
  } catch {
    // Ignore socket teardown errors after recording the guard violation.
  }
}

type ImapFlowInternal = {
  exec?: (command: string, attributes?: unknown, options?: {
    onSend?: () => void;
    untagged?: Record<string, (untagged: unknown) => Promise<void> | void>;
    [key: string]: unknown;
  }) => Promise<unknown>;
  fetchOne?: (seq: unknown, query: unknown, options?: { uid?: boolean; [key: string]: unknown }) => Promise<unknown>;
  setSocketHandlers?: () => void;
  clearSocketHandlers?: () => void;
  currentRequest?: unknown;
  socket?: {
    on?: (event: string, fn: (...args: unknown[]) => void) => unknown;
    removeListener?: (event: string, fn: (...args: unknown[]) => void) => unknown;
  } | null;
  streamer?: {
    write?: (...args: unknown[]) => boolean;
  } | null;
};

/**
 * Install command-wide wire/stream byte caps, single-UID untagged FETCH caps,
 * and raw BODY[]<offset> capture on an ImapFlow instance. No-ops on minimal unit-test mocks.
 */
export function installImapCommandGuard<T extends object>(client: T, limits?: ImapCommandGuardLimits): T {
  attachImapClientErrorGuard(client);
  const existing = commandGuardStates.get(client);
  if (existing) {
    if (limits?.maxFetchCommandBytes !== undefined) {
      existing.limits.maxFetchCommandBytes = Math.min(existing.limits.maxFetchCommandBytes, limits.maxFetchCommandBytes);
    }
    if (limits?.maxProbeCommandBytes !== undefined) {
      existing.limits.maxProbeCommandBytes = Math.min(existing.limits.maxProbeCommandBytes, limits.maxProbeCommandBytes);
    }
    if (limits?.maxControlCommandBytes !== undefined) {
      existing.limits.maxControlCommandBytes = Math.min(existing.limits.maxControlCommandBytes, limits.maxControlCommandBytes);
    }
    return client;
  }

  const state: CommandGuardState = {
    limits: {
      maxFetchCommandBytes: limits?.maxFetchCommandBytes ?? MAX_IMAP_FETCH_COMMAND_BYTES,
      maxProbeCommandBytes: limits?.maxProbeCommandBytes ?? MAX_IMAP_PROBE_COMMAND_BYTES,
      maxControlCommandBytes: limits?.maxControlCommandBytes ?? MAX_IMAP_CONTROL_COMMAND_BYTES,
    },
    activeGuard: null,
    pendingFetchSpec: null,
    lastFetchBodySections: null,
    meteredSocket: null,
  };
  commandGuardStates.set(client, state);

  const flow = client as ImapFlowInternal;
  if (typeof flow.exec !== "function") {
    return client;
  }

  const onSocketData = (chunk: unknown) => {
    const guard = state.activeGuard;
    if (!guard || guard.failed) return;
    guard.wireBytes += chunkByteLength(chunk);
    if (guard.wireBytes > guard.maxBytes) {
      failActiveGuard(state, client, new Error(`IMAP command wire response exceeded ${guard.maxBytes} bytes`));
    }
  };

  const detachSocketMeter = () => {
    if (state.meteredSocket && typeof state.meteredSocket.removeListener === "function") {
      state.meteredSocket.removeListener("data", onSocketData);
    }
    state.meteredSocket = null;
  };

  const attachSocketMeter = () => {
    const sock = flow.socket;
    if (!sock || sock === state.meteredSocket || typeof sock.on !== "function") return;
    detachSocketMeter();
    sock.on("data", onSocketData);
    state.meteredSocket = sock;
  };

  if (typeof flow.setSocketHandlers === "function") {
    const origSetSocketHandlers = flow.setSocketHandlers.bind(client);
    flow.setSocketHandlers = () => {
      detachSocketMeter();
      origSetSocketHandlers();
      attachSocketMeter();
    };
  }
  if (typeof flow.clearSocketHandlers === "function") {
    const origClearSocketHandlers = flow.clearSocketHandlers.bind(client);
    flow.clearSocketHandlers = () => {
      detachSocketMeter();
      origClearSocketHandlers();
    };
  }
  attachSocketMeter();

  const streamer = flow.streamer;
  const rawStreamerWrite = streamer?.write;
  if (streamer && typeof rawStreamerWrite === "function") {
    const origWrite = rawStreamerWrite.bind(streamer);
    streamer.write = (...args: unknown[]): boolean => {
      const guard = state.activeGuard;
      if (guard) {
        if (guard.failed) return false;
        guard.streamBytes += chunkByteLength(args[0]);
        if (guard.streamBytes > guard.maxBytes) {
          failActiveGuard(state, client, new Error(`IMAP command decoded stream exceeded ${guard.maxBytes} bytes`));
          return false;
        }
      }
      return origWrite(...args);
    };
  }

  const origExec = flow.exec.bind(client);
  flow.exec = async (command, attributes, options) => {
    const cmd = String(command ?? "").toUpperCase().trim();
    const isFetch = cmd === "FETCH" || cmd === "UID FETCH";
    let spec: ImapFetchGuardSpec | null = null;
    if (isFetch && state.pendingFetchSpec) {
      spec = state.pendingFetchSpec;
      state.pendingFetchSpec = null;
    } else if (!isFetch && BOUNDED_CONTROL_COMMANDS.has(cmd)) {
      spec = { maxBytes: state.limits.maxControlCommandBytes };
    }
    if (!spec) {
      return await origExec(command, attributes, options);
    }

    let rejectGuard!: (error: Error) => void;
    const guardAbortPromise = new Promise<never>((_resolve, reject) => {
      rejectGuard = reject;
    });
    void guardAbortPromise.catch(() => undefined);

    const guard: ActiveCommandGuard = {
      maxBytes: spec.maxBytes,
      maxFetchResponses: spec.maxFetchResponses,
      expectedUid: spec.expectedUid,
      wireBytes: 0,
      streamBytes: 0,
      untaggedFetchCount: 0,
      failed: null,
      reject: rejectGuard,
    };

    const execOptions = options ?? {};
    const prevOnSend = execOptions.onSend;
    const wrappedOptions: NonNullable<typeof options> = {
      ...execOptions,
      onSend: () => {
        guard.wireBytes = 0;
        guard.streamBytes = 0;
        state.activeGuard = guard;
        prevOnSend?.();
      },
    };

    const origUntaggedFetch = execOptions.untagged?.FETCH;
    if (isFetch && typeof origUntaggedFetch === "function") {
      wrappedOptions.untagged = {
        ...execOptions.untagged,
        FETCH: async (untagged: unknown) => {
          if (guard.failed) return;
          guard.untaggedFetchCount += 1;
          if (guard.maxFetchResponses !== undefined && guard.untaggedFetchCount > guard.maxFetchResponses) {
            failActiveGuard(
              state,
              client,
              new Error("IMAP single-message fetch received unexpected multiple FETCH responses"),
            );
            return;
          }
          const inspected = inspectFetchUntagged(untagged);
          if (guard.expectedUid !== undefined && inspected.uid !== guard.expectedUid) {
            failActiveGuard(
              state,
              client,
              new Error("IMAP body response did not match the requested UID"),
            );
            return;
          }
          state.lastFetchBodySections = inspected.bodySections;
          await origUntaggedFetch(untagged);
        },
      };
    }

    if (!flow.currentRequest) {
      state.activeGuard = guard;
    }
    const execPromise = Promise.resolve().then(() => origExec(command, attributes, wrappedOptions));
    void execPromise.catch(() => undefined);
    try {
      return await Promise.race([execPromise, guardAbortPromise]);
    } finally {
      if (state.activeGuard === guard) {
        state.activeGuard = null;
      }
    }
  };

  if (typeof flow.fetchOne === "function") {
    const origFetchOne = flow.fetchOne.bind(client);
    flow.fetchOne = async (seq, query, options) => {
      const explicitSpec = state.pendingFetchSpec;
      const expectedUid = explicitSpec?.expectedUid ?? (
        options?.uid === true && /^\d{1,10}$/.test(String(seq)) ? Number(seq) : undefined
      );
      const spec: ImapFetchGuardSpec = explicitSpec ?? {
        maxBytes: state.limits.maxFetchCommandBytes,
        maxFetchResponses: 1,
        expectedUid,
      };
      state.pendingFetchSpec = spec;
      state.lastFetchBodySections = null;
      try {
        const result = await origFetchOne(seq, query, options);
        const captured = state.lastFetchBodySections as CapturedBodySections | null;
        if (result && typeof result === "object" && captured?.valid && captured.parts.size > 0) {
          const message = result as { bodyParts?: Map<string, Buffer> };
          const merged = new Map<string, Buffer>(message.bodyParts ?? []);
          for (const [offsetKey, slice] of captured.parts) {
            merged.set(offsetKey, slice);
          }
          message.bodyParts = merged;
        }
        return result;
      } finally {
        if (state.pendingFetchSpec === spec) state.pendingFetchSpec = null;
        state.lastFetchBodySections = null;
      }
    };
  }

  return client;
}

/** Run a single-UID fetch or probe operation under an explicit command budget. */
export async function runGuardedImapFetch<T>(
  client: object,
  spec: ImapFetchGuardSpec,
  operation: () => Promise<T>,
): Promise<T> {
  const state = commandGuardStates.get(client);
  if (!state) {
    return await operation();
  }
  const configuredMax = spec.isProbe
    ? state.limits.maxProbeCommandBytes
    : state.limits.maxFetchCommandBytes;
  const effectiveSpec: ImapFetchGuardSpec = {
    ...spec,
    maxBytes: Math.min(spec.maxBytes, configuredMax),
  };
  const previousSpec = state.pendingFetchSpec;
  state.pendingFetchSpec = effectiveSpec;
  try {
    return await operation();
  } finally {
    state.pendingFetchSpec = previousSpec;
  }
}
