import { it,expect } from "vitest";
import { courseSharedSkillCommandSchema } from "./course-shared-skill";
import { courseEvidenceConditionsSchema } from "./course-route";
const a="11111111-1111-4111-8111-111111111111",b="22222222-2222-4222-8222-222222222222";
it("requires explicit cross-course conditions and a versioned confirmed mapping",()=>{
 expect(courseEvidenceConditionsSchema.safeParse({responseFormat:"numeric",timeLimitSeconds:null,assistance:"independent"}).success).toBe(true);
 expect(courseEvidenceConditionsSchema.safeParse({responseFormat:"proof",timeLimitSeconds:null,assistance:"independent"}).success).toBe(false);
 const value={action:"link",sourceRequirementId:a,expectedSourceRevision:1,targetRequirementId:b,expectedTargetRevision:1,expectedLinkRevision:0,confirmed:true};
 expect(courseSharedSkillCommandSchema.parse(value)).toEqual(value);expect(courseSharedSkillCommandSchema.safeParse({...value,confirmed:false}).success).toBe(false);expect(courseSharedSkillCommandSchema.safeParse({...value,workspaceId:a}).success).toBe(false);
});
