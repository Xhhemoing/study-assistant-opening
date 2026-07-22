import { SignJWT, jwtVerify } from "jose";

export type SessionClaims = {
  sub: string;
  workspaceId: string;
};

const encoder = new TextEncoder();

export async function createSessionToken(
  claims: SessionClaims,
  secret: string,
): Promise<string> {
  return new SignJWT({ workspaceId: claims.workspaceId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(encoder.encode(secret));
}

export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, encoder.encode(secret));
  if (typeof payload.sub !== "string" || typeof payload.workspaceId !== "string") {
    throw new Error("invalid session claims");
  }
  return { sub: payload.sub, workspaceId: payload.workspaceId };
}

export function assertObjectAccess(
  session: SessionClaims,
  resourceOwnerId: string,
): void {
  if (session.sub !== resourceOwnerId) {
    throw new Error("forbidden");
  }
}
