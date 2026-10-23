import type { WorkerRole } from "@aistudy/config";
import { preflightParser } from "../parsers/parser-preflight";
import type { ParserRunner } from "../parsers/types";
import { OPENING_QUEUE_KINDS } from "./queue";

const PARSER_QUEUES = new Set<string>(["parse", "parse-media"]);

/** Producer queues remain complete; only consumers and parser dependencies vary. */
export async function prepareWorkerRole(
  role: WorkerRole,
  checkParser: () => Promise<ParserRunner> = preflightParser,
) {
  const queueKinds = new Set<string>(OPENING_QUEUE_KINDS.filter(kind =>
    role === "all" || (role === "parser" ? PARSER_QUEUES.has(kind) : !PARSER_QUEUES.has(kind)),
  ));
  // Do not catch parser failures: all/parser must never start a broken parser consumer.
  const parserRunner = role === "learning" ? null : await checkParser();
  return { queueKinds, parserRunner };
}
