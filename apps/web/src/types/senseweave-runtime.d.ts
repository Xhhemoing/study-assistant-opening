declare module "senseweave-runtime/browser" {
  export function mountSenseWeave(
    host: HTMLElement,
    options: {
      theme?: "light" | "dark";
      capabilities?: { components?: string[]; maxInteractiveBlocks?: number };
      onError?: (error: unknown) => void;
    },
  ): Promise<{
    render(input: { id: string; content: string }): void;
    unmount(): void;
  }>;
}
