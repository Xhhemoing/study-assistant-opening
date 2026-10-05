import type { ImportIdentity } from "@aistudy/contracts";
export function importIdentityKey(identity: ImportIdentity): string {
  return JSON.stringify([identity.connectionId, identity.container, identity.generation, identity.remoteId]);
}
