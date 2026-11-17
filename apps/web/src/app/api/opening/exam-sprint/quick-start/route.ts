import { isAbsolute } from "node:path";
import { z } from "zod";
import { ApiError } from "../../../../../features/auth/service";
import { examSprintResponse } from "../../../../../features/opening/exam-sprint/http";
import { startMidtermSprint } from "../../../../../features/opening/exam-sprint/midterm-quick-start";
import { readOpeningJsonBody } from "../../../../../features/opening/request-body";
import { requireOpeningScope } from "../../../../../features/opening/runtime";

const inputSchema = z.object({}).strict();

async function getAccess(request: Request) {
  if (process.env.AISTUDY_WEB_PREVIEW !== "1") return null;
  const email = process.env.AISTUDY_MIDTERM_QUICK_START_EMAIL?.trim().toLowerCase();
  const directory = process.env.AISTUDY_MIDTERM_QUICK_START_DIR?.trim();
  if (!email || !directory || !isAbsolute(directory)) return null;
  const context = await requireOpeningScope(request);
  const account = await context.runtime.identity.findUserById(context.principal.userId);
  return account?.email?.trim().toLowerCase() === email ? { ...context, directory } : null;
}

export const GET = (request: Request) => examSprintResponse(async () => ({ available: Boolean(await getAccess(request)) }));

export const POST = (request: Request) => examSprintResponse(async () => {
  const access = await getAccess(request);
  if (!access) throw new ApiError("NOT_FOUND", "当前账号未启用高数期中一键冲刺。", 404);
  inputSchema.parse(await readOpeningJsonBody(request, 256));
  return startMidtermSprint(access.runtime, access.principal, access.directory);
});
