/**
 * 对象内进度：总数不大时画成分段（每段颜色过渡，前进/后退都有动画且不需要内联样式）；
 * 总数过大时退回原生 <progress>（与仓库 card-review-view 一致）。
 */
export function ProgressSteps({ value, max, label }: { value: number; max: number; label: string }) {
  if (max > 40) {
    return <progress value={value} max={max} aria-label={label} className="block h-0.5 w-full appearance-none overflow-hidden border-0 bg-line [&::-moz-progress-bar]:bg-accent [&::-webkit-progress-bar]:bg-line [&::-webkit-progress-value]:bg-accent" />;
  }
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="flex h-0.5 w-full gap-px">
      {Array.from({ length: max }, (_, index) => (
        <span key={index} data-done={index < value} className="h-full flex-1 bg-line transition-colors duration-(--duration-panel) ease-standard data-[done=true]:bg-accent" />
      ))}
    </div>
  );
}
