import { jwtVerify, SignJWT } from "jose";

export type PreflightGatewayClaims = {
  preflightId: string;
  sessionId: string;
  repositoryId: string;
  candidateSha: string;
  operation: "source";
};

export async function signPreflightGatewayToken(claims: PreflightGatewayClaims, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("openfloor")
    .setAudience("openfloor-runtime-gateway")
    .setIssuedAt(now)
    .setExpirationTime(now + 10 * 60)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyPreflightGatewayToken(token: string, secret: string): Promise<PreflightGatewayClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: "openfloor",
      audience: "openfloor-runtime-gateway",
      algorithms: ["HS256"],
    });
    if (
      typeof payload.preflightId !== "string" || typeof payload.sessionId !== "string"
      || typeof payload.repositoryId !== "string" || typeof payload.candidateSha !== "string"
      || payload.operation !== "source"
    ) return null;
    return {
      preflightId: payload.preflightId,
      sessionId: payload.sessionId,
      repositoryId: payload.repositoryId,
      candidateSha: payload.candidateSha,
      operation: "source",
    };
  } catch {
    return null;
  }
}

export type RunGatewayClaims = {
  runId: string;
  sessionId: string;
  repositoryId: string;
  candidateSha: string;
  operation: "source" | "openai";
};

export async function signRunGatewayToken(claims: RunGatewayClaims, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("openfloor")
    .setAudience("openfloor-runtime-gateway")
    .setIssuedAt(now)
    .setExpirationTime(now + (claims.operation === "openai" ? 60 * 60 : 10 * 60))
    .sign(new TextEncoder().encode(secret));
}

export async function verifyRunGatewayToken(token: string, secret: string, operation: RunGatewayClaims["operation"]): Promise<RunGatewayClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: "openfloor",
      audience: "openfloor-runtime-gateway",
      algorithms: ["HS256"],
    });
    if (
      typeof payload.runId !== "string" || typeof payload.sessionId !== "string"
      || typeof payload.repositoryId !== "string" || typeof payload.candidateSha !== "string"
      || payload.operation !== operation
    ) return null;
    return {
      runId: payload.runId,
      sessionId: payload.sessionId,
      repositoryId: payload.repositoryId,
      candidateSha: payload.candidateSha,
      operation,
    };
  } catch {
    return null;
  }
}
