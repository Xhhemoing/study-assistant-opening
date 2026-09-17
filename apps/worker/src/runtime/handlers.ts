import type { JobHandler } from "./run-job";

const notImplemented: JobHandler = async () => { throw new Error("not implemented until I02/T02"); };
export function createHandlers(parse: JobHandler): Record<string, JobHandler> { return { parse, tutor: notImplemented, retest: notImplemented, remind: notImplemented }; }
export const handlers = createHandlers(notImplemented);
export function handlerForKind(kind: string, map = handlers): JobHandler { const handler = map[kind]; if (!handler) throw new Error(`unknown opening job kind: ${kind}`); return handler; }
