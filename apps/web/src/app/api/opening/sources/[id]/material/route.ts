import { z } from "zod";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { materialManifestService } from "../../../../../../features/opening/server/material-services";
export async function GET(request: Request, context: { params: Promise<{id:string}> }) {
  try {
    const {scope,sql}=await requireOpeningScope(request);
    return Response.json(await materialManifestService(sql).read(scope,z.string().uuid().parse((await context.params).id)),{headers:{"Cache-Control":"no-store"}});
  } catch(error) {const response=jsonError(mapDomainError(error));response.headers.set("Cache-Control","no-store");return response;}
}
export async function PUT(request: Request, context: { params: Promise<{id:string}> }) {
  try {
    const {scope,sql}=await requireOpeningScope(request);
    return Response.json(await materialManifestService(sql).write(scope,z.string().uuid().parse((await context.params).id),await readOpeningJsonBody(request)),{headers:{"Cache-Control":"no-store"}});
  } catch(error) {const response=jsonError(mapDomainError(error));response.headers.set("Cache-Control","no-store");return response;}
}

/** Explicit editorial disclosure, recorded before answer text leaves the server. */
export async function POST(request: Request, context: { params: Promise<{id:string}> }) {
  try {
    const {scope,sql}=await requireOpeningScope(request);
    z.object({action:z.literal("reveal_answers")}).strict().parse(await readOpeningJsonBody(request));
    return Response.json(await materialManifestService(sql).revealForEditing(scope,z.string().uuid().parse((await context.params).id)),{headers:{"Cache-Control":"no-store"}});
  } catch(error) {const response=jsonError(mapDomainError(error));response.headers.set("Cache-Control","no-store");return response;}
}
