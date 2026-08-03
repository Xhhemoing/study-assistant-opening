import type { Diagnostics } from "@aistudy/contracts";

export function diagnosticsVersionEntries(diagnostics: Diagnostics): Array<[string, string]> {
  return Object.entries(diagnostics.versions).sort(([left], [right]) => left.localeCompare(right));
}

export function recentDiagnosticsEvents(diagnostics: Diagnostics) {
  return diagnostics.recentAttemptEvents.slice(-10).reverse();
}
