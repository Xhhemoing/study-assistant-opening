import { z } from "zod";
import { jsonError, mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { materialAnswerService } from "../../../../../../features/opening/server/material-services";
export async function GET(request: Request, context:{params:Promise<{id:string}>}) {
  try {
    const {scope,sql}=await requireOpeningScope(request);
    return Response.json(await materialAnswerService(sql)(scope,z.string().uuid().parse((await context.params).id)),{headers:{"Cache-Control":"no-store"}});
  } catch(error) {const response=jsonError(mapDomainError(error));response.headers.set("Cache-Control","no-store");return response;}
}
