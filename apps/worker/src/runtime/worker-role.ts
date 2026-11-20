import type { WorkerRole } from "@aistudy/config";
import type { ChamberRole } from "../chambers/chamber-ports";
import { preflightParser } from "../parsers/parser-preflight";
import type { ParserRunner } from "../parsers/types";
import { OPENING_QUEUE_KINDS } from "./queue";
import type { ParserOcrHealth } from "@aistudy/database";
import { probeParserOcr } from "../parsers/ocr-health";
import { createParserActivity } from "../parsers/parser-activity";

type RuntimeRole = WorkerRole | ChamberRole;

export function parseWorkerRole(raw: string | undefined): RuntimeRole {
  const role = raw?.trim() || "all";
  switch (role) {
    case "all": case "parser": case "learning": case "logistics": case "teaching":
      return role;
    default:
      throw new Error(`Unknown WORKER_ROLE: ${role}`);
  }
}

// New queue kinds need an explicit owner before a chamber may consume them.
const queueOwner = {
  parse: "parser", "parse-media": "parser", remind: "logistics",
  tutor: "teaching", "tutor-metadata": "teaching", retest: "teaching",
  "build-course-knowledge": "teaching", "extract-study-actions": "teaching",
  "compile-teaching-unit": "teaching", "index-source": "teaching",
  "recognize-photo-question": "teaching", "grade-observation": "teaching",
} as const satisfies Record<typeof OPENING_QUEUE_KINDS[number], ChamberRole | "parser">;

/** Producer queues remain complete; only consumers and parser dependencies vary. */
export async function prepareWorkerRole(
  rawRole: string | undefined,
  checkParser: () => Promise<ParserRunner> = preflightParser,
  health: { probe?: (signal?: AbortSignal) => Promise<ParserOcrHealth>; record?: (report: ParserOcrHealth) => Promise<void>; now?: () => number; evidenceTtlMs?: number } = {},
) {
  const role = parseWorkerRole(rawRole);
  const runsParser = role === "all" || role === "parser";
  const queueKinds = new Set<string>(OPENING_QUEUE_KINDS.filter(kind =>
    role === "all" || role === queueOwner[kind] || (role === "learning" && queueOwner[kind] !== "parser"),
  ));
  // Record even missing-model/preflight failures before refusing startup. A
  // learning-only worker must not overwrite reports from parser consumers.
  const activity = createParserActivity(health.now);
  const probe = (signal?: AbortSignal) => health.probe ? health.probe(signal) : probeParserOcr(undefined, process.env, signal);
  let lastReport: ParserOcrHealth | null = null;
  const refreshParserHealth = !runsParser ? null : async (signal?: AbortSignal) => {
    const report = lastReport?.status === "ready" && activity.canReuseHealth(health.evidenceTtlMs ?? 5 * 60_000)
      ? lastReport : await probe(signal);
    signal?.throwIfAborted();
    await health.record?.(report);
    signal?.throwIfAborted();
    lastReport = report;
    return report;
  };
  const parserOcrHealth = !runsParser ? null : await probe();
  lastReport = parserOcrHealth;
  // Do not catch parser failures: all/parser must never start a broken parser consumer.
  let parserRunner: ParserRunner | null = null;
  if (runsParser) {
    try { parserRunner = await checkParser(); }
    catch (error) {
      // Preserve import/path preflight before DB access when OCR is disabled.
      // Configured OCR failures need a persisted diagnostic before refusing startup.
      if (parserOcrHealth?.directoryConfigured) await health.record?.(parserOcrHealth.status === "ready"
        ? { ...parserOcrHealth, status: "preflight_failed", inferenceMs: null } : parserOcrHealth);
      throw error;
    }
    if (parserOcrHealth) await health.record?.(parserOcrHealth);
    if (parserOcrHealth?.status === "missing_files" || parserOcrHealth?.status === "preflight_failed") {
      throw new Error("Parser OCR startup failed; check the Worker OCR health report and prepared local models");
    }
  }
  return { queueKinds, parserRunner: parserRunner ? activity.wrap(parserRunner) : null, parserOcrHealth, refreshParserHealth };
}

const parserQueues = new Set<string>(OPENING_QUEUE_KINDS.filter(kind => queueOwner[kind] === "parser"));
export const isParserQueue = (kind: string) => parserQueues.has(kind);

/** Reconcile existing consumers only; recovery never constructs another Worker. */
export async function reconcileParserConsumers(
  consumers: Array<{ kind: string; pause(): Promise<unknown>; resume(): Promise<unknown> }>,
  isCurrent: () => boolean,
  isStopping: () => boolean,
): Promise<void> {
  for (const consumer of consumers) {
    if (isStopping()) return;
    if (!isParserQueue(consumer.kind)) continue;
    if (isCurrent()) await consumer.resume();
    else await consumer.pause();
  }
}
