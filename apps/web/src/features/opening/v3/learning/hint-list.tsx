/** 已看过的提示：逐条出现（每次新增一条上浮淡入），不写成「独立完成度」。 */
export function HintList({ hints, used }: { hints: string[]; used: number }) {
  if (used === 0) return null;
  return (
    <ol aria-label="已看的提示" className="space-y-2">
      {hints.slice(0, used).map((hint, index) => (
        <li key={index} className="rounded-ctl border-l-2 border-ai-1 bg-surface-2 px-4 py-2 text-ui text-text motion-safe:animate-enter">
          <span className="mr-2 text-meta text-text-2">提示 {index + 1}</span>{hint}
        </li>
      ))}
    </ol>
  );
}
