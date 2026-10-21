export type SessionIdentity = { id: string; workspaceId: string };

type VerifiedIdentity = { namespace: string };
const identities = new WeakMap<Window, VerifiedIdentity>();

/** AuthGate publishes only an identity verified by /api/auth/me before mounting children. */
export function publishVerifiedSessionIdentity(identity: SessionIdentity): () => void {
  if (typeof window === "undefined") return () => undefined;
  const target = window;
  const verified = { namespace: JSON.stringify([identity.id, identity.workspaceId]) };
  identities.set(target, verified);
  return () => {
    // A departing gate must not clear a newer gate's verified identity.
    if (identities.get(target) === verified) identities.delete(target);
  };
}

/** Null means drafts cannot be restored or persisted as belonging to any account. */
export function getVerifiedSessionNamespace(): string | null {
  return typeof window === "undefined" ? null : identities.get(window)?.namespace ?? null;
}
