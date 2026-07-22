import { randomUUID } from "node:crypto";
import {
  createIdentityRepository,
  hashSessionToken,
  type IdentityRepository,
} from "@aistudy/database";
import { SignJWT, jwtVerify } from "jose";
import type { Sql } from "postgres";
import type { Principal } from "./authorization";

export type SessionClaims = {
  sub: string;
  workspaceId: string;
  sid: string;
};

const encoder = new TextEncoder();

export async function createSessionJwt(
  claims: SessionClaims,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({
    workspaceId: claims.workspaceId,
    sid: claims.sid,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setJti(claims.sid)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(encoder.encode(secret));
}

export async function verifySessionJwt(
  token: string,
  secret: string,
): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, encoder.encode(secret));
  if (
    typeof payload.sub !== "string" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.sid !== "string"
  ) {
    throw new Error("invalid session claims");
  }
  return {
    sub: payload.sub,
    workspaceId: payload.workspaceId,
    sid: payload.sid,
  };
}

export type SessionService = {
  issue(input: {
    userId: string;
    workspaceId: string;
  }): Promise<{ token: string; principal: Principal; expiresAt: Date }>;
  resolve(token: string | undefined | null): Promise<Principal | null>;
  revoke(sessionId: string): Promise<void>;
};

export function createSessionService(input: {
  sql: Sql;
  authSecret: string;
  sessionTtlSeconds: number;
  identity?: IdentityRepository;
}): SessionService {
  const identity = input.identity ?? createIdentityRepository(input.sql);

  return {
    async issue({ userId, workspaceId }) {
      const expiresAt = new Date(Date.now() + input.sessionTtlSeconds * 1000);
      const sessionId = randomUUID();
      const token = await createSessionJwt(
        { sub: userId, workspaceId, sid: sessionId },
        input.authSecret,
        input.sessionTtlSeconds,
      );
      await identity.createSession({
        userId,
        sessionId,
        tokenHash: hashSessionToken(token),
        expiresAt,
      });
      return {
        token,
        principal: {
          userId,
          workspaceId,
          sessionId,
        },
        expiresAt,
      };
    },

    async resolve(token) {
      if (!token) return null;
      let claims: SessionClaims;
      try {
        claims = await verifySessionJwt(token, input.authSecret);
      } catch {
        return null;
      }
      const session = await identity.findValidSession(claims.sid);
      if (!session) return null;
      if (session.userId !== claims.sub) return null;
      if (hashSessionToken(token) !== session.tokenHash) return null;

      const workspace = await identity.getWorkspaceForUser(session.userId);
      if (workspace.id !== claims.workspaceId) return null;

      return {
        userId: session.userId,
        workspaceId: workspace.id,
        sessionId: session.id,
      };
    },

    async revoke(sessionId) {
      await identity.revokeSession(sessionId);
    },
  };
}
