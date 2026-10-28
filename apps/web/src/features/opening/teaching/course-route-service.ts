import { courseRouteConfirmSchema,courseRouteStartSchema,courseRouteNextSchema,courseRouteRetestScheduleSchema,courseRouteVerificationConfirmSchema,uuidSchema,type Scope } from "@aistudy/contracts";
import { isTeachingCompilerEnabled } from "@aistudy/ai";
import { createOpeningCourseRouteRepository,createOpeningCourseRouteRetestRepository,createOpeningCourseRouteVerificationRepository } from "@aistudy/database";
import type { Sql } from "postgres";
export function createCourseRouteService(sql:Sql,env:Record<string,string|undefined>=process.env){
  const repository=createOpeningCourseRouteRepository(sql,{compilerEnabled:isTeachingCompilerEnabled(env)});
  const retests=createOpeningCourseRouteRetestRepository(sql);
  const verification=createOpeningCourseRouteVerificationRepository(sql);
  return {read(scope:Scope,courseId:string,activityId?:string){return repository.read(scope,uuidSchema.parse(courseId),activityId?uuidSchema.parse(activityId):undefined);},
    confirm(scope:Scope,courseId:string,raw:unknown){return repository.confirm(scope,uuidSchema.parse(courseId),courseRouteConfirmSchema.parse(raw));},
    start(scope:Scope,courseId:string,raw:unknown){return repository.start(scope,uuidSchema.parse(courseId),courseRouteStartSchema.parse(raw));},
    next(scope:Scope,courseId:string,raw:unknown){return repository.next(scope,uuidSchema.parse(courseId),courseRouteNextSchema.parse(raw));},
    scheduleRetest(scope:Scope,courseId:string,raw:unknown){return retests.schedule(scope,uuidSchema.parse(courseId),courseRouteRetestScheduleSchema.parse(raw));},
    readTask(scope:Scope,courseId:string,taskId:string){return retests.readTask(scope,uuidSchema.parse(courseId),uuidSchema.parse(taskId));},
    readVerification(scope:Scope,courseId:string,activityId:string){return verification.read(scope,uuidSchema.parse(courseId),uuidSchema.parse(activityId));},
    confirmVerification(scope:Scope,courseId:string,raw:unknown){return verification.confirm(scope,uuidSchema.parse(courseId),courseRouteVerificationConfirmSchema.parse(raw));}};
}
