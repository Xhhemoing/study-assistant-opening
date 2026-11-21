import {
  callCartridgeDataMethod, cloneCartridgeData, copyCartridgeArray, isInspectableCartridgeFunction,
  isInspectableCartridgeObject, readCartridgeDataProperty,
} from "./clone-cartridge-data";
import { deepFreeze } from "./probe-definition";
import type { DistinguishableProbeSpec, ProbeDistinguishabilityReport } from "./probe-protocol";
import { inspectProbe, publishVerifiedProbe } from "./published-probe";
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
      issues.push({ code: "evidence_probe_not_distinguishable", detail: `${probeId}: ${safeErrorDetail(error)}` });
      reports.push(deepFreeze<ProbeDistinguishabilityReport>({
        probeId, distinguishable: false, predictions: [], ambiguousPairs: [],
        degenerateAgainstCorrectModel: [], issues: ["prediction_failed"],
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

function wrapCartridge(
  cartridge: AnyTeachingCartridge,
  pinnedManifest: Readonly<CartridgeManifest>,
  pinnedEvidenceContract: Readonly<CartridgeEvidenceContract> | undefined,
): AnyTeachingCartridge {
  const { level } = pinnedManifest;
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
        const result = callCartridgeDataMethod(cartridge, method, cloneCartridgeData(args));
        // Raw list/lookup identity is used during validation only.
        if (method === "getProbe") {
          return result === null ? null : publishVerifiedProbe(result);
        }
        if (method === "listProbes") {
          return Object.freeze(copyCartridgeArray(result as readonly unknown[])
            .map(publishVerifiedProbe));
        }
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
