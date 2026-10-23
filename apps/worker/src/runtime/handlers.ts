import type { JobHandler } from "./run-job";

const notImplemented: JobHandler = async () => { throw new Error("not implemented until I02/T02"); };
export function createHandlers(
  parse: JobHandler,
  extras: {
    retest?: JobHandler;
    remind?: JobHandler;
    tutor?: JobHandler;
    "tutor-metadata"?: JobHandler;
    "build-course-knowledge"?: JobHandler;
    "parse-media"?: JobHandler;
    "extract-study-actions"?: JobHandler;
    "compile-teaching-unit"?: JobHandler;
    "index-source"?: JobHandler;
    "recognize-photo-question"?: JobHandler;
  } = {},
): Record<string, JobHandler> {
  return {
    parse,
    tutor: extras.tutor ?? notImplemented,
    "tutor-metadata": extras["tutor-metadata"] ?? notImplemented,
    retest: extras.retest ?? notImplemented,
    remind: extras.remind ?? notImplemented,
    "build-course-knowledge": extras["build-course-knowledge"] ?? notImplemented,
    "parse-media": extras["parse-media"] ?? notImplemented,
    "extract-study-actions": extras["extract-study-actions"] ?? notImplemented,
    "compile-teaching-unit": extras["compile-teaching-unit"] ?? notImplemented,
    "index-source": extras["index-source"] ?? notImplemented,
    "recognize-photo-question": extras["recognize-photo-question"] ?? notImplemented,
  };
}
export const handlers = createHandlers(notImplemented);
export function handlerForKind(kind: string, map = handlers): JobHandler {
  const handler = map[kind];
  if (!handler) throw new Error(`unknown opening job kind: ${kind}`);
  return handler;
}
