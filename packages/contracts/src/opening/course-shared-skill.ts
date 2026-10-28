import { z } from "zod";
import { uuidSchema } from "./foundation";
import { courseRequirementSchema } from "./course-route";
const choice=z.object({requirement:courseRequirementSchema,courseTitle:z.string(),goals:z.array(z.object({id:uuidSchema,title:z.string()}).strict())}).strict();
export const courseSharedSkillLinkSchema=z.object({id:uuidSchema,sourceRequirementId:uuidSchema,sourceRequirementRevision:z.number().int().positive(),targetRequirementId:uuidSchema,targetRequirementRevision:z.number().int().positive(),stableSkillId:uuidSchema,revision:z.number().int().positive(),active:z.boolean(),effective:z.boolean(),reason:z.string().nullable(),observationIds:z.array(uuidSchema)}).strict();
export const courseSharedSkillReadSchema=z.object({courseId:uuidSchema,requirements:z.array(choice),candidates:z.array(choice),links:z.array(courseSharedSkillLinkSchema)}).strict();
export const courseSharedSkillCommandSchema=z.discriminatedUnion("action",[
 z.object({action:z.literal("link"),sourceRequirementId:uuidSchema,expectedSourceRevision:z.number().int().positive(),targetRequirementId:uuidSchema,expectedTargetRevision:z.number().int().positive(),expectedLinkRevision:z.number().int().nonnegative(),confirmed:z.literal(true)}).strict(),
 z.object({action:z.literal("unlink"),linkId:uuidSchema,expectedRevision:z.number().int().positive()}).strict(),
]);
export type CourseSharedSkillRead=z.infer<typeof courseSharedSkillReadSchema>;
export type CourseSharedSkillCommand=z.infer<typeof courseSharedSkillCommandSchema>;
