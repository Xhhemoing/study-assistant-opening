import type { LearningResume } from "@aistudy/contracts";
import { formatMatrixCells, formatVectorCells, parseMatrixTransformParams, type MatrixTransformParams } from "@aistudy/domain";

/** Only the visible current block is eligible; never inspect hidden answers or future blocks. */
export function continueMathObject(activity: { id?: string; contentVersion?: number } | null | undefined, resume?: LearningResume | null): MatrixTransformParams | null {
  if (!activity?.id || !resume || activity.id !== resume.activityId || activity.contentVersion !== resume.contentVersion
    || resume.clientInit?.activityId !== activity.id || resume.clientInit.contentVersion !== resume.contentVersion) return null;
  const block = resume.clientInit.blocks.find(row => row.blockId === resume.thoughtTrain.currentBlockId);
  if (!block || block.role === "answer_key" || !["matrix_transform", "matrix-viz", "matrix_viz", "matrixviz"].includes(block.blockType)) return null;
  const parsed = parseMatrixTransformParams(block.content);
  return parsed.ok ? parsed.value : null;
}

export function ContinueMathPreview({ object }: { object: MatrixTransformParams }) {
  const rows = formatMatrixCells(object.matrixA), vector = formatVectorCells(object.vectorX);
  return <figure className="mt-4 inline-flex max-w-full flex-col gap-2 overflow-x-auto rounded-xl border border-line bg-surface-2 px-4 py-3" aria-label="当前数学对象缩略图">
    <figcaption className="text-xs text-text-3">当前块的矩阵与输入向量</figcaption>
    <div className="flex items-center gap-3 font-mono text-sm tabular-nums text-text">
      <span className="sr-only">矩阵：</span><div className="space-y-1 rounded-sm border-x-2 border-text-3 px-2">{rows.map((row, index) => <div key={index} className="flex gap-3">{row.map((value, column) => <span key={column} className="min-w-6 flex-1 text-center">{value}</span>)}</div>)}</div>
      <span aria-hidden="true">×</span><span className="sr-only">输入向量：</span><div className="space-y-1 rounded-sm border-x-2 border-text-3 px-2">{vector.map((value, index) => <div key={index} className="min-w-6 text-center">{value}</div>)}</div>
    </div>
  </figure>;
}
