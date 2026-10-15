export type InlineAttemptDraft = { answer: string; skillLabel: string; prompt: string };
export function inlineAttemptIdentityKey(activityId: string, blockId: string, version: number): string {
  return `${activityId}:${blockId}:v${version}`;
}

/** Memory only: a changed teaching revision gets a fresh form without losing an unsent answer. */
export function createInlineAttemptDrafts() {
  const values = new Map<string, InlineAttemptDraft>();
  return {
    get: (key: string) => values.get(key),
    set(key: string, value: InlineAttemptDraft | null) { if (value) values.set(key, value); else values.delete(key); },
    previous(activityId: string, blockId: string, version: number) {
      const prefix = `${activityId}:${blockId}:v`;
      const current = inlineAttemptIdentityKey(activityId, blockId, version);
      return [...values.entries()].filter(([key, draft]) => key.startsWith(prefix) && key !== current && draft.answer.trim());
    },
  };
}
