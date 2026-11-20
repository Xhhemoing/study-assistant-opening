import { verifyProbeDistinguishability, type ProbeDistinguishabilityReport } from "./probe-protocol";
import {
  CARTRIDGE_LEVEL_METHODS,
  cartridgeManifestSchema,
  meetsCapabilityLevel,
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
  const contract = cartridge.evidenceContract;
  if (!contract?.evaluatorVersion || !contract.specVersion) {
    issues.push({ code: "evidence_contract_missing", detail: "evidenceContract.evaluatorVersion/specVersion required" });
  }
  let probes: ReturnType<EvidenceCartridge<unknown>["listProbes"]>;
  try {
    probes = cartridge.listProbes();
  } catch (error) {
    issues.push({ code: "evidence_probe_listing_failed", detail: String(error) });
    return [];
  }
  if (!Array.isArray(probes) || probes.length === 0) {
    issues.push({ code: "evidence_probes_missing", detail: "L4_EVIDENCE requires at least one probe" });
    return [];
  }
  const seen = new Set<string>();
  const reports: ProbeDistinguishabilityReport[] = [];
  for (const probe of probes) {
    if (seen.has(probe.probeId)) issues.push({ code: "evidence_probe_id_duplicate", detail: probe.probeId });
    seen.add(probe.probeId);
    if (cartridge.getProbe(probe.probeId) !== probe) {
      issues.push({ code: "evidence_probe_lookup_mismatch", detail: probe.probeId });
    }
    const report = verifyProbeDistinguishability(probe);
    reports.push(report);
    if (!report.distinguishable) {
      issues.push({ code: "evidence_probe_not_distinguishable", detail: `${probe.probeId}: ${report.issues.join(", ")}` });
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
  const parsed = cartridgeManifestSchema.safeParse((candidate as { manifest?: unknown }).manifest);
  if (!parsed.success) {
    return { ok: false, probeReports: [],
      issues: parsed.error.issues.map(issue => ({ code: "manifest_invalid" as const, detail: `${issue.path.join(".")}: ${issue.message}` })) };
  }
  const manifest = parsed.data;
  const issues: CartridgeRegistrationIssue[] = [];
  for (const method of CARTRIDGE_LEVEL_METHODS[manifest.level]) {
    if (typeof (candidate as Record<string, unknown>)[method] !== "function") {
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
      entries.set(report.manifest.id, cartridge as AnyTeachingCartridge);
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
