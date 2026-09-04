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

export type PreviewGatewayClaims = {
  previewId: string;
  generation: number;
  sessionId: string;
  repositoryId: string;
  candidateSha: string;
  operation: "source";
};

export async function signPreviewGatewayToken(claims: PreviewGatewayClaims, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("openfloor")
    .setAudience("openfloor-runtime-gateway")
    .setIssuedAt(now)
    .setExpirationTime(now + 10 * 60)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyPreviewGatewayToken(token: string, secret: string): Promise<PreviewGatewayClaims | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: "openfloor",
      audience: "openfloor-runtime-gateway",
      algorithms: ["HS256"],
    });
    if (
      typeof payload.previewId !== "string" || typeof payload.generation !== "number"
      || !Number.isSafeInteger(payload.generation) || payload.generation < 1
      || typeof payload.sessionId !== "string" || typeof payload.repositoryId !== "string"
      || typeof payload.candidateSha !== "string" || !/^[0-9a-f]{40}$/.test(payload.candidateSha)
      || payload.operation !== "source"
    ) return null;
    return {
      previewId: payload.previewId,
      generation: payload.generation,
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
  operation: "source" | "openai" | "anthropic" | "kimi" | "gemini" | "glm" | "qwen" | "deepseek" | "bundle_upload" | "bundle_read" | "events" | "context" | "conflict_source" | "conflict_input";
};

// The "wait for Codex" step allows 60 minutes (worker/agent-run-workflow.ts),
// so a 60-minute model token expires at exactly the boundary of the longest
// permitted run — equal, not greater. The openai operation gets 90 minutes so a
// full-length run cannot outlive its own credential; the step timeout is
// deliberately NOT shortened, since that would cut the longest possible run for
// every provider to solve an openai-only problem.
const RUN_TOKEN_TTL_SECONDS: Partial<Record<RunGatewayClaims["operation"], number>> = { openai: 90 * 60 };
const LONG_LIVED_OPERATIONS = ["anthropic", "kimi", "gemini", "glm", "qwen", "deepseek", "events", "context", "conflict_input"];

export async function signRunGatewayToken(claims: RunGatewayClaims, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = RUN_TOKEN_TTL_SECONDS[claims.operation]
    ?? (LONG_LIVED_OPERATIONS.includes(claims.operation) ? 60 * 60 : 10 * 60);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("openfloor")
    .setAudience("openfloor-runtime-gateway")
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
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
