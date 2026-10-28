import { expect, it } from "vitest";
import { buildAnswerGradingInput } from "./answer-grading";
import { rankPedagogy } from "../../../../tests/fixtures/opening/teaching/rank-pedagogy";

it("supplies the saved misconception dictionary separately from student work", () => {
  const input = buildAnswerGradingInput({ question: "3×5矩阵的秩为2，零空间维数？", answer: "3-2=1", referenceText: "5-2=3", imageParts: [], ...rankPedagogy });
  expect(JSON.parse(input.text)).toMatchObject({ studentAnswer: "3-2=1", misconceptions: rankPedagogy.misconceptions });
  expect(input.instruction).toContain("不要发明新的id");
  expect(input.instruction).toContain("followUp 检查同一误解");
});
it("keeps original photo transcription and the explicit correction separate from the saved proof answer",()=>{
  const interpretation={kind:"photo_transcription" as const,version:1,workSource:{id:"00000000-0000-4000-8000-000000000001",version:1,physicalPage:1},
    originalTranscriptionObservationId:"00000000-0000-4000-8000-000000000002",originalTranscription:"v为零",correctedTranscription:"v非零",previousInterpretationObservationId:null,correctionReason:"非字漏识别"};
  const input=buildAnswerGradingInput({question:"证明特征向量非零",answer:"v非零",referenceText:"特征向量定义",imageParts:[],interpretation});
  expect(JSON.parse(input.text)).toMatchObject({studentAnswer:"v非零",photoTranscriptionCorrection:interpretation});
  expect(input.instruction).toContain("必要步骤有错或未知");expect(input.instruction).toContain("不是新的独立作答");
});
