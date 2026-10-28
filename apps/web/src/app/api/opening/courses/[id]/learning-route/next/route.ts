import { jsonError,mapDomainError } from "../../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../../features/opening/request-body";
import { createCourseRouteService } from "../../../../../../../features/opening/teaching/course-route-service";
import { teachingLoopApiDenied } from "../../../../../../../server/opening-config";
export async function POST(request:Request,context:{params:Promise<{id:string}>}){try{
  const {scope,sql}=await requireOpeningScope(request),courseId=(await context.params).id;
  const denied=teachingLoopApiDenied(scope.ownerUserId);if(denied)return denied;
  return Response.json(await createCourseRouteService(sql).next(scope,courseId,await readOpeningJsonBody(request)),{headers:{"Cache-Control":"no-store"}});
}catch(error){return jsonError(mapDomainError(error));}}
