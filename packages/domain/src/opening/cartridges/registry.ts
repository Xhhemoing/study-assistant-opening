import { verifyProbeDistinguishability, type ProbeDistinguishabilityReport } from "./probe-protocol";
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
    super(`cartridge registration rejected: ${issues.map(issue => issue.code).join(", ")}`);
    this.name = "CartridgeRegistrationError";
    this.issues = issues;
  }
}

function validateEvidenceContracts(
  cartridge: EvidenceCartridge<unknown>,
  issues: CartridgeRegistrationIssue[],
): ProbeDistinguishabilityReport[] {
  try {
    if (!hasValidEvidenceContract(cartridge.evidenceContract)) {
      issues.push({ code: "evidence_contract_missing", detail: "evidenceContract.evaluatorVersion/specVersion must be non-blank strings" });
    }
  } catch (error) {
    issues.push({ code: "evidence_contract_missing", detail: safeErrorDetail(error) });
  }
  let probes: ReturnType<EvidenceCartridge<unknown>["listProbes"]>;
  try {
    probes = cartridge.listProbes();
  } catch (error) {
    issues.push({ code: "evidence_probe_listing_failed", detail: safeErrorDetail(error) });
    return [];
  }
  if (!Array.isArray(probes) || probes.length === 0) {
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
      lookedUp = cartridge.getProbe(probeId);
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
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, issues: [{ code: "cartridge_not_object", detail: typeof candidate }], probeReports: [] };
  }
  let parsed: ReturnType<typeof cartridgeManifestSchema.safeParse>;
  try {
    parsed = cartridgeManifestSchema.safeParse((candidate as { manifest?: unknown }).manifest);
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
      hasMethod = typeof (candidate as Record<string, unknown>)[method] === "function";
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

function wrapCartridge(cartridge: AnyTeachingCartridge, pinnedManifest: Readonly<CartridgeManifest>): AnyTeachingCartridge {
  const { level } = pinnedManifest;
  const facade: AnyTeachingCartridge = {
    manifest: pinnedManifest,
    serializeContinuityState(state) { return cartridge.serializeContinuityState(state); },
    parseContinuityState(raw) { return cartridge.parseContinuityState(raw); },
    buildResumeSummary(raw) {
      const state = restoreContinuityState(value => cartridge.parseContinuityState(value), raw);
      return cartridge.buildResumeSummary(state);
    },
  };
  const properties = level === "L4_EVIDENCE"
    ? [...CARTRIDGE_LEVEL_METHODS[level], "evidenceContract"]
    : CARTRIDGE_LEVEL_METHODS[level];
  for (const property of properties) {
    if (Object.hasOwn(facade, property)) continue;
    Object.defineProperty(facade, property, {
      enumerable: true,
      get() {
        const member: unknown = Reflect.get(cartridge, property);
        return typeof member === "function" ? member.bind(cartridge) : member;
      },
    });
  }
  return Object.freeze(facade);
}

export function createCartridgeRegistry(initial: readonly unknown[] = []): CartridgeRegistry {
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
  for (const cartridge of initial) {
    const result = registry.registerCartridge(cartridge);
    if (!result.ok) throw new CartridgeRegistrationError(result.issues);
  }
  return registry;
}

export function registerCartridge(registry: CartridgeRegistry, cartridge: unknown): CartridgeRegistrationResult {
  return registry.registerCartridge(cartridge);
}

export function getCartridge(registry: CartridgeRegistry, id: string): AnyTeachingCartridge | null {
  return registry.getCartridge(id);
}

export function listCartridgesByCapability(
  registry: CartridgeRegistry,
  level: CartridgeCapabilityLevel,
): AnyTeachingCartridge[] {
  return registry.listCartridgesByCapability(level);
}
