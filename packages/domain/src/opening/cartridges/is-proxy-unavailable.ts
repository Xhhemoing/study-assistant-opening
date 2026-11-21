// Inspection fails closed on runtimes without a trap-free Proxy detector.
export const isProxy: ((value: unknown) => boolean) | undefined = undefined;
