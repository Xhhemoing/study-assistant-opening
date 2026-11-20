import {
  cloneCartridgeData, copyCartridgeArray, isInspectableCartridgeFunction, isInspectableCartridgeObject,
  readCartridgeDataProperty,
} from "./clone-cartridge-data";
import { verifyProbeDistinguishability, type DistinguishableProbeSpec, type ProbeDistinguishabilityReport } from "./probe-protocol";
import {
  CARTRIDGE_LEVEL_METHODS,
  cartridgeManifestSchema,
  hasValidEvidenceContract,
  meetsCapabilityLevel,
  restoreContinuityState,
  safeErrorDetail,
  type AnyTeachingCartridge,
  type CartridgeCapabilityLevel,
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

function validateEvidenceContracts(
  cartridge: EvidenceCartridge<unknown>,
  issues: CartridgeRegistrationIssue[],
): ProbeDistinguishabilityReport[] {
  try {
    if (!hasValidEvidenceContract(readCartridgeDataProperty(cartridge, "evidenceContract"))) {
      issues.push({ code: "evidence_contract_missing", detail: "evidenceContract.evaluatorVersion/specVersion must be non-blank strings" });
    }
  } catch (error) {
    issues.push({ code: "evidence_contract_missing", detail: safeErrorDetail(error) });
  }
  let probes: DistinguishableProbeSpec<unknown, unknown>[];
  try {
    probes = copyCartridgeArray(callDefinitionMethod(cartridge, "listProbes", []));
  } catch (error) {
    issues.push({ code: "evidence_probe_listing_failed", detail: safeErrorDetail(error) });
    return [];
  }
  if (probes.length === 0) {
    issues.push({ code: "evidence_probes_missing", detail: "L4_EVIDENCE requires at least one probe" });
    return [];
  }
  const seen = new Set<string>();
  const reports: ProbeDistinguishabilityReport[] = [];
  for (const probe of probes) {
    const report = verifyProbeDistinguishability(probe);
    reports.push(report);
    const probeId = report.probeId;
    if (probeId && seen.has(probeId)) issues.push({ code: "evidence_probe_id_duplicate", detail: probeId });
    if (probeId) seen.add(probeId);
    let lookedUp: unknown;
    let lookupFailed = false;
    try {
      lookedUp = callDefinitionMethod(cartridge, "getProbe", [probeId]);
    } catch (error) {
      lookupFailed = true;
      issues.push({ code: "evidence_probe_lookup_failed", detail: `${probeId}: ${safeErrorDetail(error)}` });
    }
    if (!lookupFailed && lookedUp !== probe) {
      issues.push({ code: "evidence_probe_lookup_mismatch", detail: probeId });
    }
    if (!report.distinguishable) {
      issues.push({ code: "evidence_probe_not_distinguishable", detail: `${probeId}: ${report.issues.join(", ")}` });
    }
  }
  return reports;
}

/**
 * Validate a cartridge against the capability level its manifest declares. A higher
 * level must satisfy every lower-level contract; L4 additionally requires every probe
 * to pass the distinguishability pre-check.
 */
export function validateCartridge(candidate: unknown): CartridgeValidationReport {
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
  let probeReports: ProbeDistinguishabilityReport[] = [];
  if (manifest.level === "L4_EVIDENCE" && issues.length === 0) {
    probeReports = validateEvidenceContracts(candidate as EvidenceCartridge<unknown>, issues);
  }
  return issues.length ? { ok: false, issues, probeReports } : { ok: true, manifest, probeReports };
}

export interface CartridgeRegistry {
  registerCartridge(cartridge: unknown): CartridgeRegistrationResult;
  getCartridge(id: string): AnyTeachingCartridge | null;
  listCartridges(): AnyTeachingCartridge[];
  /** Cartridges whose declared level satisfies at least `level`, ordered by id. */
  listCartridgesByCapability(level: CartridgeCapabilityLevel): AnyTeachingCartridge[];
}

function callDefinitionMethod<T extends object, K extends keyof T & string>(definition: T, key: K, args: unknown[]):
  T[K] extends (...args: never[]) => infer TResult ? TResult : never;
function callDefinitionMethod(definition: object, key: string, args: unknown[]): unknown;
function callDefinitionMethod(definition: object, key: string, args: unknown[]): unknown {
  const method = readCartridgeDataProperty(definition, key);
  if (!isInspectableCartridgeFunction(method)) throw new TypeError(`Cartridge definition requires ${key}()`);
  return Reflect.apply(method, definition, args);
}

function wrapCartridge(cartridge: AnyTeachingCartridge, pinnedManifest: Readonly<CartridgeManifest>): AnyTeachingCartridge {
  const { level } = pinnedManifest;
  const facade: AnyTeachingCartridge = {
    manifest: pinnedManifest,
    serializeContinuityState(state) {
      const serialized = callDefinitionMethod(cartridge, "serializeContinuityState", [cloneCartridgeData(state)]);
      if (typeof serialized !== "string") throw new TypeError("Cartridge serialization must return a string");
      return serialized;
    },
    parseContinuityState(raw) {
      return cloneCartridgeData(callDefinitionMethod(cartridge, "parseContinuityState", [cloneCartridgeData(raw)]));
    },
    buildResumeSummary(raw) {
      const state = restoreContinuityState(value => callDefinitionMethod(cartridge, "parseContinuityState", [value]), raw);
      return cloneCartridgeData(callDefinitionMethod(cartridge, "buildResumeSummary", [state]));
    },
  };
  if (level === "L4_EVIDENCE") {
    Object.defineProperty(facade, "evidenceContract", {
      enumerable: true, value: readCartridgeDataProperty(cartridge, "evidenceContract"),
    });
  }
  for (const method of CARTRIDGE_LEVEL_METHODS[level]) {
    if (Object.hasOwn(facade, method)) continue;
    Object.defineProperty(facade, method, {
      enumerable: true,
      value(...args: unknown[]): unknown {
        const result = callDefinitionMethod(cartridge, method, cloneCartridgeData(args));
        // Probe definitions contain executable callbacks and retain identity for registry checks.
        if (method === "getProbe") {
          if (result !== null && !isInspectableCartridgeObject(result)) {
            throw new TypeError("Cartridge lookup must return an inspectable probe or null");
          }
          return result;
        }
        if (method === "listProbes") return copyCartridgeArray(result as readonly unknown[]);
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
      const report = validateCartridge(cartridge);
      if (!report.ok) return report;
      if (entries.has(report.manifest.id)) {
        return { ok: false, probeReports: report.probeReports,
          issues: [{ code: "duplicate_cartridge_id", detail: report.manifest.id }] };
      }
      // The validated schema has only scalar fields, so freezing this copy covers the whole manifest.
      const pinnedManifest = Object.freeze({ ...report.manifest });
      entries.set(pinnedManifest.id, wrapCartridge(cartridge as AnyTeachingCartridge, pinnedManifest));
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
  return cloneCartridgeData(callDefinitionMethod(registry, "registerCartridge", [cartridge]));
}

export function getCartridge(registry: CartridgeRegistry, id: string): AnyTeachingCartridge | null {
  return callDefinitionMethod(registry, "getCartridge", [id]);
}

export function listCartridgesByCapability(
  registry: CartridgeRegistry,
  level: CartridgeCapabilityLevel,
): AnyTeachingCartridge[] {
  return copyCartridgeArray(callDefinitionMethod(registry, "listCartridgesByCapability", [level]));
}
