/** Keep only events reachable from a retained original, with each target before its corrections. */
export function retainBackupEventChains<T extends Record<string, unknown>>(
  events: readonly T[],
  correctionKey: "correctsEventId" | "corrects_event_id",
): T[] {
  const retained: T[] = [];
  const corrections = new Map<unknown, T[]>();
  for (const event of events) {
    const target = event[correctionKey];
    if (target == null) {
      if (event.type !== "correction") retained.push(event);
      continue;
    }
    const siblings = corrections.get(target) ?? [];
    siblings.push(event);
    corrections.set(target, siblings);
  }
  for (const event of retained) {
    const children = corrections.get(event.id);
    if (!children) continue;
    corrections.delete(event.id);
    for (const child of children) retained.push(child);
  }
  return retained;
}
