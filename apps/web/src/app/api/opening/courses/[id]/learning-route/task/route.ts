import { jsonError,mapDomainError } from "../../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";
import { createCourseRouteService } from "../../../../../../../features/opening/teaching/course-route-service";
export async function GET(request:Request,context:{params:Promise<{id:string}>}){try{
  const {scope,sql}=await requireOpeningScope(request),courseId=(await context.params).id;
  return Response.json(await createCourseRouteService(sql).readTask(scope,courseId,new URL(request.url).searchParams.get("taskId")??""),{headers:{"Cache-Control":"no-store"}});
}catch(error){return jsonError(mapDomainError(error));}}
