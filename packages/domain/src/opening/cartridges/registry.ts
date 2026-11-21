import {
  callCartridgeDataMethod, cloneCartridgeData, copyCartridgeArray, isInspectableCartridgeFunction,
  isInspectableCartridgeObject, readCartridgeDataProperty,
} from "./clone-cartridge-data";
import { deepFreeze, ProbeDefinitionError } from "./probe-definition";
import type { DistinguishableProbeSpec, ProbeDistinguishabilityReport } from "./probe-protocol";
import { inspectProbe, markProbeRejection, publishInspectedProbe } from "./published-probe";
import {
  CARTRIDGE_LEVEL_METHODS,
  cartridgeManifestSchema,
  hasValidEvidenceContract,
  meetsCapabilityLevel,
  restoreContinuityState,
  safeErrorDetail,
  type AnyTeachingCartridge,
  type CartridgeCapabilityLevel,
  type CartridgeEvidenceContract,
  type CartridgeManifest,
  type EvidenceCartridge,
} from "./types";

export type CartridgeRegistrationIssueCode =
  | "cartridge_not_object"
  | "manifest_invalid"
  | "duplicate_cartridge_id"
  | "missing_capability_method"
  | "evidence_contract_missing"
  | "evidence_probes_missing"
  | "evidence_probe_id_duplicate"
  | "evidence_probe_lookup_mismatch"
  | "evidence_probe_lookup_failed"
  | "evidence_probe_not_distinguishable"
  | "evidence_probe_listing_failed";

export interface CartridgeRegistrationIssue {
  code: CartridgeRegistrationIssueCode;
  detail: string;
}

export type CartridgeValidationReport =
  | { ok: true; manifest: CartridgeManifest; probeReports: ProbeDistinguishabilityReport[] }
  | { ok: false; issues: CartridgeRegistrationIssue[]; probeReports: ProbeDistinguishabilityReport[] };

export type CartridgeRegistrationResult = CartridgeValidationReport;

export class CartridgeRegistrationError extends Error {
  readonly issues: CartridgeRegistrationIssue[];
  constructor(issues: CartridgeRegistrationIssue[]) {
    const captured = cloneCartridgeData(issues);
    super(`cartridge registration rejected: ${captured.map(issue => issue.code).join(", ")}`);
    this.name = "CartridgeRegistrationError";
    this.issues = captured;
  }
}

function readProbeId(probe: unknown): string {
  try {
    const id = readCartridgeDataProperty(probe, "probeId");
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

function validateEvidenceContracts(
  cartridge: EvidenceCartridge<unknown>,
  issues: CartridgeRegistrationIssue[],
): { pinnedEvidenceContract?: Readonly<CartridgeEvidenceContract>; probeReports: ProbeDistinguishabilityReport[] } {
  let pinnedEvidenceContract: Readonly<CartridgeEvidenceContract> | undefined;
  try {
    const contract = cloneCartridgeData(readCartridgeDataProperty(cartridge, "evidenceContract"));
    if (hasValidEvidenceContract(contract)) {
      const { evaluatorVersion, specVersion } = contract;
      pinnedEvidenceContract = Object.freeze({ evaluatorVersion, specVersion });
    } else {
      issues.push({ code: "evidence_contract_missing", detail: "evidenceContract.evaluatorVersion/specVersion must be non-blank strings" });
    }
  } catch (error) {
    issues.push({ code: "evidence_contract_missing", detail: safeErrorDetail(error) });
  }
  let probes: DistinguishableProbeSpec<unknown, unknown>[];
  try {
    probes = copyCartridgeArray(callCartridgeDataMethod(cartridge, "listProbes", []));
  } catch (error) {
    issues.push({ code: "evidence_probe_listing_failed", detail: safeErrorDetail(error) });
    return { pinnedEvidenceContract, probeReports: [] };
  }
  if (probes.length === 0) {
    issues.push({ code: "evidence_probes_missing", detail: "L4_EVIDENCE requires at least one probe" });
    return { pinnedEvidenceContract, probeReports: [] };
  }
  const seen = new Set<string>();
  const reports: ProbeDistinguishabilityReport[] = [];
  for (const probe of probes) {
    const probeId = readProbeId(probe);
    if (probeId && seen.has(probeId)) issues.push({ code: "evidence_probe_id_duplicate", detail: probeId });
    if (probeId) seen.add(probeId);
    if (probeId) {
      try {
        const lookedUp = callCartridgeDataMethod(cartridge, "getProbe", [probeId]);
        if (lookedUp !== probe || readProbeId(probe) !== probeId) {
          issues.push({ code: "evidence_probe_lookup_mismatch", detail: probeId });
        }
      } catch (error) {
        issues.push({ code: "evidence_probe_lookup_failed", detail: `${probeId}: ${safeErrorDetail(error)}` });
      }
    }
    try {
      const { snapshot: { report } } = inspectProbe(probe);
      reports.push(report);
      if (!report.distinguishable) {
        issues.push({ code: "evidence_probe_not_distinguishable", detail: `${probeId}: ${report.issues.join(", ")}` });
      }
    } catch (error) {
      const issue = error instanceof ProbeDefinitionError ? error.issue : "prediction_failed" as const;
      const detail = error instanceof ProbeDefinitionError ? error.issue : safeErrorDetail(error);
      issues.push({ code: "evidence_probe_not_distinguishable", detail: `${probeId}: ${detail}` });
      reports.push(deepFreeze<ProbeDistinguishabilityReport>({
        probeId, distinguishable: false, predictions: [], ambiguousPairs: [],
        degenerateAgainstCorrectModel: [], issues: [issue],
      }));
    }
  }
  return { pinnedEvidenceContract, probeReports: reports };
}

type CartridgeDefinitionValidation =
  | (Extract<CartridgeValidationReport, { ok: true }> & { pinnedEvidenceContract?: Readonly<CartridgeEvidenceContract> })
  | Extract<CartridgeValidationReport, { ok: false }>;

/**
 * Validate a cartridge against the capability level its manifest declares. A higher
 * level must satisfy every lower-level contract; L4 additionally requires every probe
 * to pass the distinguishability pre-check. Pass the source cartridge definition.
 * Registered L4 facades return independent snapshots and do not satisfy raw lookup identity.
 */
export function validateCartridge(candidate: unknown): CartridgeValidationReport {
  const result = validateCartridgeDefinition(candidate);
  return result.ok ? { ok: true, manifest: result.manifest, probeReports: result.probeReports } : result;
}

function validateCartridgeDefinition(candidate: unknown): CartridgeDefinitionValidation {
  if (!isInspectableCartridgeObject(candidate)) {
    return { ok: false, issues: [{ code: "cartridge_not_object", detail: typeof candidate }], probeReports: [] };
  }
  let parsed: ReturnType<typeof cartridgeManifestSchema.safeParse>;
  try {
    parsed = cartridgeManifestSchema.safeParse(cloneCartridgeData(readCartridgeDataProperty(candidate, "manifest")));
  } catch (error) {
    return { ok: false, probeReports: [], issues: [{ code: "manifest_invalid", detail: safeErrorDetail(error) }] };
  }
  if (!parsed.success) {
    return { ok: false, probeReports: [],
      issues: parsed.error.issues.map(issue => ({ code: "manifest_invalid" as const, detail: `${issue.path.join(".")}: ${issue.message}` })) };
  }
  const manifest = parsed.data;
  const issues: CartridgeRegistrationIssue[] = [];
  for (const method of CARTRIDGE_LEVEL_METHODS[manifest.level]) {
    let hasMethod = false;
    try {
      hasMethod = isInspectableCartridgeFunction(readCartridgeDataProperty(candidate, method));
    } catch {
      hasMethod = false;
    }
    if (!hasMethod) {
      issues.push({ code: "missing_capability_method", detail: `${manifest.level} requires ${method}()` });
    }
  }
  const { pinnedEvidenceContract, probeReports } = manifest.level === "L4_EVIDENCE" && issues.length === 0
    ? validateEvidenceContracts(candidate as EvidenceCartridge<unknown>, issues)
    : { probeReports: [] };
  return issues.length ? { ok: false, issues, probeReports } : { ok: true, manifest, probeReports, pinnedEvidenceContract };
}

export interface CartridgeRegistry {
  registerCartridge(cartridge: unknown): CartridgeRegistrationResult;
  getCartridge(id: string): AnyTeachingCartridge | null;
  listCartridges(): AnyTeachingCartridge[];
  /** Cartridges whose declared level satisfies at least `level`, ordered by id. */
  listCartridgesByCapability(level: CartridgeCapabilityLevel): AnyTeachingCartridge[];
}

function structurallyEqual(
  left: unknown,
  right: unknown,
  compared = new WeakMap<object, WeakSet<object>>(),
): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;

  const previouslyCompared = compared.get(left);
  if (previouslyCompared?.has(right)) return true;
  if (previouslyCompared) previouslyCompared.add(right);
  else compared.set(left, new WeakSet([right]));

  const leftPrototype = Object.getPrototypeOf(left);
  const rightPrototype = Object.getPrototypeOf(right);
  if (leftPrototype !== rightPrototype) return false;

  if (leftPrototype === Date.prototype) {
    return Date.prototype.getTime.call(left) === Date.prototype.getTime.call(right);
  }
  if (leftPrototype === Map.prototype) {
    const leftEntries = [...Map.prototype.entries.call(left)];
    const rightEntries = [...Map.prototype.entries.call(right)];
    if (leftEntries.length !== rightEntries.length) return false;
    for (let index = 0; index < leftEntries.length; index += 1) {
      const leftEntry = leftEntries[index]!;
      const rightEntry = rightEntries[index]!;
      if (!structurallyEqual(leftEntry[0], rightEntry[0], compared)
        || !structurallyEqual(leftEntry[1], rightEntry[1], compared)) return false;
    }
  } else if (leftPrototype === Set.prototype) {
    const leftEntries = [...Set.prototype.values.call(left)];
    const rightEntries = [...Set.prototype.values.call(right)];
    if (leftEntries.length !== rightEntries.length) return false;
    for (let index = 0; index < leftEntries.length; index += 1) {
      if (!structurallyEqual(leftEntries[index], rightEntries[index], compared)) return false;
    }
  } else if (leftPrototype === ArrayBuffer.prototype) {
    const leftBytes = new Uint8Array(left as ArrayBuffer);
    const rightBytes = new Uint8Array(right as ArrayBuffer);
    if (leftBytes.length !== rightBytes.length) return false;
    for (let index = 0; index < leftBytes.length; index += 1) {
      if (leftBytes[index] !== rightBytes[index]) return false;
    }
  } else if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) return false;
    if (leftPrototype === DataView.prototype) {
      if (rightPrototype !== DataView.prototype) return false;
      const leftView = left as DataView;
      const rightView = right as DataView;
      if (leftView.byteLength !== rightView.byteLength) return false;
      const leftBytes = new Uint8Array(leftView.buffer, leftView.byteOffset, leftView.byteLength);
      const rightBytes = new Uint8Array(rightView.buffer, rightView.byteOffset, rightView.byteLength);
      for (let index = 0; index < leftBytes.length; index += 1) {
        if (leftBytes[index] !== rightBytes[index]) return false;
      }
    }
  }

  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!rightKeys.some(candidate => Object.is(candidate, key))) return false;
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, key);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, key);
    if (!leftDescriptor || !rightDescriptor
      || leftDescriptor.enumerable !== rightDescriptor.enumerable
      || leftDescriptor.configurable !== rightDescriptor.configurable
      || Object.hasOwn(leftDescriptor, "writable") !== Object.hasOwn(rightDescriptor, "writable")
      || (Object.hasOwn(leftDescriptor, "writable") && leftDescriptor.writable !== rightDescriptor.writable)) {
      return false;
    }
    const leftData = Object.hasOwn(leftDescriptor, "value");
    const rightData = Object.hasOwn(rightDescriptor, "value");
    if (leftData !== rightData) return false;
    if (leftData) {
      if (!structurallyEqual(leftDescriptor.value, rightDescriptor.value, compared)) return false;
    } else if (!Object.is(leftDescriptor.get, rightDescriptor.get) || !Object.is(leftDescriptor.set, rightDescriptor.set)) {
      return false;
    }
  }
  return true;
}

function wrapCartridge(
  cartridge: AnyTeachingCartridge,
  pinnedManifest: Readonly<CartridgeManifest>,
  pinnedEvidenceContract: Readonly<CartridgeEvidenceContract> | undefined,
): AnyTeachingCartridge {
  const { level } = pinnedManifest;
  type RuntimeProbe = DistinguishableProbeSpec<unknown, unknown>;
  type RuntimeProbeCallbacks = {
    observableKey: unknown;
    parseResponse: unknown;
    correctPredict: unknown;
    hypothesisPredict: readonly unknown[];
  };
  type InspectedRuntimeProbe = {
    raw: unknown;
    probe: RuntimeProbe;
    definition: unknown;
    signature: unknown;
    callbacks: RuntimeProbeCallbacks;
    snapshot: ReturnType<typeof inspectProbe>["snapshot"];
  };

  const canonicalRecord = (value: object, excluded: readonly string[]): Record<string, unknown> => {
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError("Cartridge probe requires string keys");
      if (!excluded.includes(key)) {
        Object.defineProperty(record, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: readCartridgeDataProperty(value, key),
        });
      }
    }
    return record;
  };

  const canonicalDefinition = (probe: RuntimeProbe) => ({
    data: canonicalRecord(probe, ["correctModel", "hypotheses", "observableKey", "parseResponse"]),
    correctModel: canonicalRecord(probe.correctModel, ["predict"]),
    hypotheses: probe.hypotheses.map(hypothesis => canonicalRecord(hypothesis, ["predict"])),
  });

  const readRuntimeProbeCallbacks = (raw: unknown): RuntimeProbeCallbacks => {
    const correctModel = readCartridgeDataProperty(raw, "correctModel");
    const hypotheses = readCartridgeDataProperty(raw, "hypotheses");
    if (!isInspectableCartridgeObject(correctModel) || !isInspectableCartridgeObject(hypotheses)
      || Object.getPrototypeOf(hypotheses) !== Array.prototype) {
      throw new TypeError("Cartridge probe requires inspectable model records");
    }
    return {
      observableKey: readCartridgeDataProperty(raw, "observableKey"),
      parseResponse: readCartridgeDataProperty(raw, "parseResponse"),
      correctPredict: readCartridgeDataProperty(correctModel, "predict"),
      hypothesisPredict: copyCartridgeArray(hypotheses as readonly unknown[])
        .map(hypothesis => readCartridgeDataProperty(hypothesis, "predict")),
    };
  };

  const callbacksEqual = (left: RuntimeProbeCallbacks, right: RuntimeProbeCallbacks): boolean =>
    Object.is(left.observableKey, right.observableKey)
    && Object.is(left.parseResponse, right.parseResponse)
    && Object.is(left.correctPredict, right.correctPredict)
    && left.hypothesisPredict.length === right.hypothesisPredict.length
    && left.hypothesisPredict.every((callback, index) => Object.is(callback, right.hypothesisPredict[index]));

  const inspectRuntimeProbe = (raw: unknown): InspectedRuntimeProbe => {
    const { probe, snapshot } = inspectProbe(raw);
    const definition = canonicalDefinition(probe);
    const clonedDefinition = cloneCartridgeData(definition);
    const signature = cloneCartridgeData({
      definition,
      report: snapshot.report,
      correctObservableKey: snapshot.correctObservableKey,
    });
    return {
      raw,
      probe,
      definition: clonedDefinition,
      signature,
      callbacks: readRuntimeProbeCallbacks(raw),
      snapshot,
    };
  };

  const assertLookupAgreement = (listed: InspectedRuntimeProbe, lookedUp: unknown, probeId: string): void => {
    if (lookedUp === null) throw new TypeError(`Cartridge getProbe(${probeId}) returned null for a listed probe`);
    if (lookedUp !== listed.raw) {
      throw new TypeError(`Cartridge getProbe(${probeId}) disagrees with listProbes()`);
    }
    const inspectedLookup = inspectRuntimeProbe(lookedUp);
    if (inspectedLookup.probe.probeId !== probeId
      || !structurallyEqual(inspectedLookup.definition, listed.definition)
      || !structurallyEqual(inspectedLookup.signature, listed.signature)
      || !callbacksEqual(inspectedLookup.callbacks, listed.callbacks)) {
      throw new TypeError(`Cartridge getProbe(${probeId}) disagrees with listProbes()`);
    }
  };

  const readRuntimeProbeCatalog = (): InspectedRuntimeProbe[] => {
    const rawProbes = copyCartridgeArray(callCartridgeDataMethod(cartridge, "listProbes", []) as readonly unknown[]);
    if (rawProbes.length === 0) throw new TypeError("L4_EVIDENCE requires at least one probe");
    const seen = new Set<string>();
    const inspected: InspectedRuntimeProbe[] = [];
    for (const rawProbe of rawProbes) {
      const listed = inspectRuntimeProbe(rawProbe);
      const probeId = listed.probe.probeId;
      if (typeof probeId !== "string" || probeId.length === 0) {
        throw new TypeError("Cartridge probe requires a non-blank probeId");
      }
      if (seen.has(probeId)) throw new TypeError(`Cartridge listProbes() returned duplicate probe id ${probeId}`);
      seen.add(probeId);
      const lookedUp = callCartridgeDataMethod(cartridge, "getProbe", [probeId]);
      assertLookupAgreement(listed, lookedUp, probeId);
      inspected.push(listed);
    }
    return inspected;
  };

  const facade: AnyTeachingCartridge = {
    manifest: pinnedManifest,
    serializeContinuityState(state) {
      const serialized = callCartridgeDataMethod(cartridge, "serializeContinuityState", [cloneCartridgeData(state)]);
      if (typeof serialized !== "string") throw new TypeError("Cartridge serialization must return a string");
      return serialized;
    },
    parseContinuityState(raw) {
      return cloneCartridgeData(callCartridgeDataMethod(cartridge, "parseContinuityState", [cloneCartridgeData(raw)]));
    },
    buildResumeSummary(raw) {
      const state = restoreContinuityState(value => callCartridgeDataMethod(cartridge, "parseContinuityState", [value]), raw);
      return cloneCartridgeData(callCartridgeDataMethod(cartridge, "buildResumeSummary", [state]));
    },
  };
  if (pinnedEvidenceContract) {
    Object.defineProperty(facade, "evidenceContract", {
      enumerable: true, value: pinnedEvidenceContract,
    });
  }
  for (const method of CARTRIDGE_LEVEL_METHODS[level]) {
    if (Object.hasOwn(facade, method)) continue;
    Object.defineProperty(facade, method, {
      enumerable: true,
      value(...args: unknown[]): unknown {
        if (method === "getProbe") {
          const clonedArgs = cloneCartridgeData(args);
          const requestedId = clonedArgs[0];
          if (typeof requestedId !== "string") return null;
          const catalog = readRuntimeProbeCatalog();
          const listed = catalog.find(candidate => candidate.probe.probeId === requestedId);
          if (listed) return publishInspectedProbe(listed.probe, listed.snapshot);
          const lookedUp = callCartridgeDataMethod(cartridge, "getProbe", clonedArgs);
          if (lookedUp === null) return null;
          const inspectedLookup = inspectRuntimeProbe(lookedUp);
          if (inspectedLookup.probe.probeId !== requestedId) {
            const error = new TypeError(`Cartridge getProbe(${safeErrorDetail(requestedId)}) returned a different probe id`);
            throw markProbeRejection(error, inspectedLookup.snapshot.report);
          }
          return publishInspectedProbe(inspectedLookup.probe, inspectedLookup.snapshot);
        }
        if (method === "listProbes") {
          return Object.freeze(readRuntimeProbeCatalog()
            .map(candidate => publishInspectedProbe(candidate.probe, candidate.snapshot)));
        }
        const result = callCartridgeDataMethod(cartridge, method, cloneCartridgeData(args));
        return cloneCartridgeData(result);
      },
    });
  }
  return Object.freeze(facade);
}

export function createCartridgeRegistry(initial?: readonly unknown[]): CartridgeRegistry {
  const entries = new Map<string, AnyTeachingCartridge>();
  const registry: CartridgeRegistry = {
    registerCartridge(cartridge) {
      const result = validateCartridgeDefinition(cartridge);
      if (!result.ok) return result;
      const { pinnedEvidenceContract, ...report } = result;
      if (entries.has(report.manifest.id)) {
        return { ok: false, probeReports: report.probeReports,
          issues: [{ code: "duplicate_cartridge_id", detail: report.manifest.id }] };
      }
      // The validated schema has only scalar fields, so freezing this copy covers the whole manifest.
      const pinnedManifest = Object.freeze({ ...report.manifest });
      entries.set(pinnedManifest.id, wrapCartridge(cartridge as AnyTeachingCartridge, pinnedManifest, pinnedEvidenceContract));
      return report;
    },
    getCartridge(id) {
      return entries.get(id) ?? null;
    },
    listCartridges() {
      return [...entries.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    },
    listCartridgesByCapability(level) {
      return registry.listCartridges().filter(cartridge => meetsCapabilityLevel(cartridge.manifest.level, level));
    },
  };
  for (const cartridge of initial === undefined ? [] : copyCartridgeArray(initial)) {
    const result = registry.registerCartridge(cartridge);
    if (!result.ok) throw new CartridgeRegistrationError(result.issues);
  }
  return registry;
}

export function registerCartridge(registry: CartridgeRegistry, cartridge: unknown): CartridgeRegistrationResult {
  return cloneCartridgeData(callCartridgeDataMethod(registry, "registerCartridge", [cartridge]));
}

export function getCartridge(registry: CartridgeRegistry, id: string): AnyTeachingCartridge | null {
  return callCartridgeDataMethod(registry, "getCartridge", [id]);
}

export function listCartridgesByCapability(
  registry: CartridgeRegistry,
  level: CartridgeCapabilityLevel,
): AnyTeachingCartridge[] {
  return copyCartridgeArray(callCartridgeDataMethod(registry, "listCartridgesByCapability", [level]));
}
