import type { JobHandler } from "./run-job";

const notImplemented: JobHandler = async () => {
  throw new Error("not implemented until I02/T02");
};

export const handlers: Record<string, JobHandler> = {
  parse: notImplemented,
  tutor: notImplemented,
  retest: notImplemented,
  remind: notImplemented,
};

export function handlerForKind(kind: string): JobHandler {
  const handler = handlers[kind];
  if (!handler) throw new Error(`unknown opening job kind: ${kind}`);
  return handler;
}
