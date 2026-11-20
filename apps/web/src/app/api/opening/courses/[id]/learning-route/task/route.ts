import { jsonError,mapDomainError } from "../../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../../features/opening/runtime";
import { createCourseRouteService } from "../../../../../../../features/opening/teaching/course-route-service";
export async function GET(request:Request,context:{params:Promise<{id:string}>}){try{
  const {scope,sql}=await requireOpeningScope(request),courseId=(await context.params).id;
  const params=new URL(request.url).searchParams;
  const task=await createCourseRouteService(sql).readTask(scope,courseId,params.get("taskId")??"",{
    includeRetestId:params.get("includeRetestId")==="true",
  });
  return Response.json(task,{headers:{"Cache-Control":"no-store"}});
}catch(error){return jsonError(mapDomainError(error));}}
