import { jsonError,mapDomainError } from "../../../../../../features/auth/service";
import { requireOpeningScope } from "../../../../../../features/opening/runtime";
import { readOpeningJsonBody } from "../../../../../../features/opening/request-body";
import { createCourseSharedSkillService } from "../../../../../../features/opening/teaching/course-shared-skill-service";
type Context={params:Promise<{id:string}>};
export async function GET(request:Request,context:Context){try{const {scope,sql}=await requireOpeningScope(request);return Response.json(await createCourseSharedSkillService(sql).read(scope,(await context.params).id),{headers:{"Cache-Control":"no-store"}});}catch(error){return jsonError(mapDomainError(error));}}
export async function POST(request:Request,context:Context){try{const {scope,sql}=await requireOpeningScope(request);return Response.json(await createCourseSharedSkillService(sql).command(scope,(await context.params).id,await readOpeningJsonBody(request)),{headers:{"Cache-Control":"no-store"}});}catch(error){return jsonError(mapDomainError(error));}}
