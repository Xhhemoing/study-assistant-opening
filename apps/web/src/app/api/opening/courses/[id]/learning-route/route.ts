import { jsonError,mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { createCourseRouteService } from "../../../../../../features/opening/teaching/course-route-service";
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,context:Context){try{
  const {scope,sql}=await requireOpeningScope(request),courseId=(await context.params).id;
  return Response.json(await createCourseRouteService(sql).read(scope,courseId,new URL(request.url).searchParams.get("activityId")??undefined),{headers:{"Cache-Control":"no-store"}});
}catch(error){return jsonError(mapDomainError(error));}}
export async function PUT(request:Request,context:Context){try{
  const {scope,sql}=await requireOpeningScope(request),courseId=(await context.params).id;
  return Response.json(await createCourseRouteService(sql).confirm(scope,courseId,await readOpeningJsonBody(request)),{headers:{"Cache-Control":"no-store"}});
}catch(error){return jsonError(mapDomainError(error));}}
