import { z } from "zod";
import { isoDateTimeSchema, uuidSchema } from "./foundation";
import { teachingActivitySchema } from "./teaching-activity";
import { retestActivityStatusSchema } from "./retest-activity";

export const courseRequirementSourceRefSchema = z.object({ sourceId:uuidSchema,sourceVersion:z.number().int().nonnegative(),
  chunkId:uuidSchema.optional(),page:z.number().int().positive().optional() }).strict();
export const courseRequirementVerificationSchema = z.object({kind:z.enum(["exact","rubric","manual","unavailable"]),
  status:z.enum(["ready","needs_check","missing"]),exerciseKeys:z.array(z.string().min(1).max(200)),
  rubric:z.string().min(1).max(12000).nullable(),missingReasons:z.array(z.string().min(1).max(500))}).strict();
export const courseEvidenceConditionsSchema=z.object({responseFormat:z.enum(["numeric","choice","text"]),timeLimitSeconds:z.number().int().positive().max(14400).nullable(),assistance:z.literal("independent")}).strict();
const requirementDefinition = {id:uuidSchema,stableSkillId:uuidSchema,knowledgeNodeId:uuidSchema.nullable(),
  requirementKey:z.string().trim().min(1).max(200),title:z.string().trim().min(1).max(200),position:z.number().int().nonnegative(),
  mandatory:z.boolean(),goalIds:z.array(uuidSchema),prerequisiteIds:z.array(uuidSchema),sourceRefs:z.array(courseRequirementSourceRefSchema),
  evidenceConditions:courseEvidenceConditionsSchema.optional(),verification:courseRequirementVerificationSchema,origin:z.enum(["syllabus","confirmed","extracted"])};
export const courseRouteRequirementInputSchema = z.object(requirementDefinition).strict();
export const courseRequirementSchema = z.object({...requirementDefinition,courseId:uuidSchema,revision:z.number().int().positive(),
  lifecycle:z.enum(["active","archived"]),approvedAt:isoDateTimeSchema.nullable()}).strict();
export const courseRouteConfirmSchema = z.object({expectedRevisions:z.array(z.object({id:uuidSchema,revision:z.number().int().positive()}).strict()),
  requirements:z.array(courseRouteRequirementInputSchema).min(1),confirmScope:z.literal(true)}).strict().superRefine((value,ctx)=>{
  for(const key of ["id","requirementKey","stableSkillId"] as const) if(new Set(value.requirements.map(row=>row[key])).size!==value.requirements.length)
    ctx.addIssue({code:"custom",message:`Duplicate ${key}`});
  const ids=new Set(value.requirements.map(row=>row.id));
  for(const row of value.requirements) if(row.prerequisiteIds.some(id=>id===row.id||!ids.has(id)))
    ctx.addIssue({code:"custom",message:"Prerequisites must reference another requirement in this course"});
});
const actionBase={goalId:uuidSchema,expectedGoalRevision:z.number().int().positive(),clientKey:z.string().min(8).max(160),
  minutes:z.number().int().min(5).max(180).default(20)};
export const courseRouteStartSchema=z.object({...actionBase,requirementId:uuidSchema,expectedRequirementRevision:z.number().int().positive(),
  taskId:uuidSchema.optional(),expectedTaskVersion:z.number().int().positive().optional()}).strict()
  .refine(value=>(value.taskId===undefined)===(value.expectedTaskVersion===undefined),"Task identity and version must be supplied together");
export const courseRouteNextSchema=z.object({...actionBase,activityId:uuidSchema,expectedPathVersion:z.number().int().positive(),observationId:uuidSchema.nullable()}).strict();
export const courseRequirementProgressSchema=z.object({requirement:courseRequirementSchema,
  status:z.enum(["unobserved","needs_correction","assisted","needs_verification","verified","blocked"]),
  sharedEvidence:z.array(z.object({linkId:uuidSchema,observationId:uuidSchema,sourceCourseId:uuidSchema,sourceRequirementId:uuidSchema,sourceActivityId:uuidSchema.nullable(),applicableGoalIds:z.array(uuidSchema)}).strict()).optional(),observationId:uuidSchema.nullable(),missingReasons:z.array(z.string()),sourcesAvailable:z.boolean(),
  delayedCheck:z.object({status:z.enum(["not_scheduled","pending","passed","failed","assisted","insufficient_evidence","expired","cancelled"]),
    retestId:uuidSchema.nullable(),taskId:uuidSchema.nullable(),notBeforeAt:isoDateTimeSchema.nullable()}).strict().optional()}).strict();
export const courseRouteActivityContextSchema=z.object({goalId:uuidSchema,goalRevision:z.number().int().positive(),
  requirementId:uuidSchema,requirementRevision:z.number().int().positive(),stableSkillId:uuidSchema,requirementKey:z.string().min(1).max(200),
  action:z.enum(["diagnose","targeted_explain","reduced_help_practice","transfer_check","full_explain","prerequisite","return","comprehensive"]),
  returnTo:uuidSchema.optional(),originActivityId:uuidSchema.optional(),originObservationId:uuidSchema.nullable().optional(),
  coveredRequirementIds:z.array(uuidSchema).optional(),comprehensiveRunKey:z.string().min(8).max(200).optional(),retestId:uuidSchema.optional()}).strict();
export const courseRouteSnapshotSchema=z.object({courseId:uuidSchema,scopeState:z.enum(["missing","unconfirmed","confirmed"]),
  requirements:z.array(courseRequirementProgressSchema),suggestions:z.array(courseRouteRequirementInputSchema),
  summary:z.object({total:z.number().int(),mandatory:z.number().int(),verified:z.number().int(),blocked:z.number().int()}).strict(),
  materials:z.array(z.object({sourceId:uuidSchema,sourceVersion:z.number().int(),title:z.string(),available:z.boolean()}).strict()),
  currentActivity:teachingActivitySchema.nullable(),currentRoute:courseRouteActivityContextSchema.nullable(),observationId:uuidSchema.nullable()}).strict();
export const courseRouteActionResultSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("ready"),activity:teachingActivitySchema,href:z.string(),resumed:z.boolean(),
    requirementId:uuidSchema,action:z.enum(["diagnose","targeted_explain","reduced_help_practice","transfer_check","full_explain","prerequisite","return","comprehensive"])}).strict(),
  z.object({kind:z.literal("choice"),reason:z.enum(["scope_unconfirmed","source_unavailable","verification_unavailable","evidence_unknown","evidence_changed","configuration","course_complete","retest_waiting","retest_expired","retest_cancelled"]),
    message:z.string(),courseId:uuidSchema,href:z.string(),requirementIds:z.array(uuidSchema)}).strict(),
]);
export type CourseRequirement=z.infer<typeof courseRequirementSchema>;
export type CourseRouteRequirementInput=z.infer<typeof courseRouteRequirementInputSchema>;
export type CourseRequirementProgress=z.infer<typeof courseRequirementProgressSchema>;
export type CourseRouteSnapshot=z.infer<typeof courseRouteSnapshotSchema>;
export type CourseRouteConfirm=z.infer<typeof courseRouteConfirmSchema>;
export type CourseRouteStart=z.infer<typeof courseRouteStartSchema>;
export type CourseRouteNext=z.infer<typeof courseRouteNextSchema>;
export type CourseRouteActionResult=z.infer<typeof courseRouteActionResultSchema>;
export type CourseRouteActivityContext=z.infer<typeof courseRouteActivityContextSchema>;
export const courseRouteRetestScheduleSchema=courseRouteNextSchema.extend({observationId:uuidSchema});
export const courseRouteRetestReceiptSchema=z.object({courseId:uuidSchema,taskId:uuidSchema,retestId:uuidSchema,
  notBeforeAt:isoDateTimeSchema,taskStatus:z.enum(["pending","done","skipped"]),retestStatus:retestActivityStatusSchema,href:z.string()}).strict();
export const courseRouteTaskContextSchema=z.discriminatedUnion("managed",[
  z.object({managed:z.literal(false)}).strict(),
  z.object({managed:z.literal(true),courseId:uuidSchema,taskId:uuidSchema,expectedTaskVersion:z.number().int().positive(),
    goalId:uuidSchema,expectedGoalRevision:z.number().int().positive(),requirementId:uuidSchema,expectedRequirementRevision:z.number().int().positive(),
    minutes:z.number().int().min(5).max(180),notBeforeAt:isoDateTimeSchema.nullable(),available:z.boolean(),reason:z.string().nullable()}).strict(),
]);
export type CourseRouteRetestSchedule=z.infer<typeof courseRouteRetestScheduleSchema>;
export type CourseRouteRetestReceipt=z.infer<typeof courseRouteRetestReceiptSchema>;
export type CourseRouteTaskContext=z.infer<typeof courseRouteTaskContextSchema>;
export const courseRouteVerificationReadSchema=z.object({courseId:uuidSchema,activityId:uuidSchema,contentVersion:z.number().int().nonnegative(),
  requirementId:uuidSchema,requirementRevision:z.number().int().positive(),rubric:z.string().nullable(),
  items:z.array(z.object({itemVersionId:uuidSchema,prompt:z.string(),referenceText:z.string().optional()}).strict()),available:z.boolean(),reason:z.string().nullable()}).strict();
export const courseRouteVerificationConfirmSchema=z.object({goalId:uuidSchema,expectedGoalRevision:z.number().int().positive(),activityId:uuidSchema,
  expectedContentVersion:z.number().int().positive(),requirementId:uuidSchema,expectedRequirementRevision:z.number().int().positive(),
  itemVersionIds:z.array(uuidSchema).min(1).max(32),confirmed:z.literal(true)}).strict();
export type CourseRouteVerificationRead=z.infer<typeof courseRouteVerificationReadSchema>;
export type CourseRouteVerificationConfirm=z.infer<typeof courseRouteVerificationConfirmSchema>;
