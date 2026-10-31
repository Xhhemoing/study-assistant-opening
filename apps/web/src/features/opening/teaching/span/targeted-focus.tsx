export function SpanTargetedFocus({ text }: { text?: string }) {
  return text ? <section aria-label="上次错在这一步" className="space-y-2 rounded-lg border border-line p-3"><h3 className="text-sm font-medium">上次错在这一步</h3><p className="text-sm leading-7">{text}</p></section> : null;
}
