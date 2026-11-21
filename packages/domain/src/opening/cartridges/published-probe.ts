import { cloneProbeDefinition } from "./probe-definition";
import {
  snapshotAndVerifyProbe,
  type DistinguishableProbeSpec,
  type ProbeDistinguishabilityReport,
  type VerifiedProbeSnapshot,
} from "./probe-protocol";

type Probe = DistinguishableProbeSpec<unknown, unknown>;

// Each runtime read creates a fresh immutable probe. Reuse its predictions only
// when evidence qualification consumes that exact probe.
const publishedSnapshots = new WeakMap<Probe, VerifiedProbeSnapshot>();

const rejectionReports = new WeakMap<object, ProbeDistinguishabilityReport>();

export function readProbeRejection(error: unknown): ProbeDistinguishabilityReport | undefined {
  return error !== null && typeof error === "object" ? rejectionReports.get(error) : undefined;
}

export function markProbeRejection(error: Error, report: ProbeDistinguishabilityReport): Error {
  rejectionReports.set(error, report);
  return error;
}

export function inspectProbe(value: unknown) {
  const probe = cloneProbeDefinition(value);
  return { probe, snapshot: snapshotAndVerifyProbe(probe) };
}

export function publishInspectedProbe(probe: Probe, snapshot: VerifiedProbeSnapshot): Probe {
  const { report } = snapshot;
  if (!report.distinguishable) {
    const error = new TypeError(`Cartridge probe ${report.probeId} is not distinguishable: ${report.issues.join(", ")}`);
    markProbeRejection(error, report);
    throw error;
  }
  publishedSnapshots.set(probe, snapshot);
  return probe;
}

export function publishVerifiedProbe(value: unknown): Probe {
  const { probe, snapshot } = inspectProbe(value);
  return publishInspectedProbe(probe, snapshot);
}

export function readProbeSnapshot(probe: Probe): VerifiedProbeSnapshot {
  return publishedSnapshots.get(probe) ?? inspectProbe(probe).snapshot;
}
