import { expect,it } from "vitest";
import { materialManifestSchema } from "./material-manifest";
const key={family:'T1',number:'6',subquestion:''};
const source='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const valid={role:'mixed',sections:[{startPage:1,endPage:1,role:'exercise'},{startPage:2,endPage:2,role:'answer_key'}],questions:[{...key,page:1,stem:'z + 3z̄ = 4 + 2i'}],answers:[{page:2,questionSourceId:source,questionSourceVersion:0,question:key,text:'z=1-i',status:'unverified',reason:''}]};
it('keeps answer numbering as a link instead of a second original question',()=>{
 const result=materialManifestSchema.parse(valid);expect(result.questions).toHaveLength(1);expect(result.answers[0]!.question).toEqual(key);
});
it('rejects body duplicates, overlapping roles and answer pages promoted to questions',()=>{
 for(const value of [{...valid,questions:[...valid.questions,...valid.questions]},
 {...valid,sections:[...valid.sections,{startPage:1,endPage:2,role:'lecture'}]},
 {...valid,questions:[{...valid.questions[0]!,page:2}]}])expect(materialManifestSchema.safeParse(value).success).toBe(false);
});
it('permits the same original number only in another family or subquestion',()=>{
 expect(materialManifestSchema.parse({...valid,questions:[...valid.questions,{...valid.questions[0]!,family:'T2'},{...valid.questions[0]!,subquestion:'a'}]}).questions).toHaveLength(3);
});
it('requires a reason for trusted or disputed answers; unverified is the default',()=>{
 for(const status of ['trusted','disputed'])expect(materialManifestSchema.safeParse({...valid,answers:[{...valid.answers[0]!,status}]}).success).toBe(false);
 expect(materialManifestSchema.parse({...valid,answers:[{...valid.answers[0]!,status:'disputed',reason:'疑似提取漏横线'}]}).answers[0]!.status).toBe('disputed');
});
