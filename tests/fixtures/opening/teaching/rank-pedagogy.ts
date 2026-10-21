import type { TeachingMisconception, TeachingStartChoice } from "@aistudy/contracts";

export const rankPedagogy: { misconceptions: TeachingMisconception[]; startChoice: TeachingStartChoice } = {
  misconceptions: [
    { id: "rows_for_columns", manifestation: "用行数减秩求零空间维数。", reason: "齐次方程的未知量个数等于列数，行数是方程个数。", correction: "先数列数，再减去主元数。" },
    { id: "rank_is_nullity", manifestation: "把秩直接当成零空间维数。", reason: "秩数的是主元变量，零空间维数数的是自由变量。", correction: "用主元变量数加自由变量数等于列数来核对。" },
  ],
  startChoice: {
    correct: { step: "先写出秩加零空间维数等于列数。", why: "每个未知量要么是主元变量，要么是自由变量。" },
    misconception: { step: "先用行数减去秩。", why: "行数不是未知量的个数。", misconceptionId: "rows_for_columns" },
  },
};
