export type TemplateName = 'text' | 'explain' | 'compare' | 'plan' | 'calculate';
export const TEMPLATES: Readonly<
  Record<TemplateName, {label: string; components: string[]; guide: string}>
>;
export function routePrompt(prompt: string): {template: TemplateName; reason: string};
