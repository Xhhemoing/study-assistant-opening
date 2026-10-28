import { courseSharedSkillCommandSchema,uuidSchema,type Scope } from "@aistudy/contracts";
import { createOpeningCourseSharedSkillRepository } from "@aistudy/database";
import type { Sql } from "postgres";
export function createCourseSharedSkillService(sql:Sql){const repository=createOpeningCourseSharedSkillRepository(sql);return {
 read:(scope:Scope,courseId:string)=>repository.read(scope,uuidSchema.parse(courseId)),
 command:(scope:Scope,courseId:string,raw:unknown)=>repository.command(scope,uuidSchema.parse(courseId),courseSharedSkillCommandSchema.parse(raw)),
};}
