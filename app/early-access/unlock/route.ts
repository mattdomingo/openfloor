import { env } from "cloudflare:workers";
import { BASE_PATH } from "@/components/basePath";
import { getAccessUser } from "@/app/access-auth";
import { grantEarlyAccess } from "@/db/early-access";
import { upsertUser } from "@/db/sessions";
import { accessSignInPath, safeAppReturnPath } from "@/lib/access-paths";
import {
  EARLY_ACCESS_PENDING_COOKIE,
  EARLY_ACCESS_PENDING_TTL_MS,
  signPendingEarlyAccess,
  verifyEarlyAccessPasscode,
  type EarlyAccessBindings,
} from "@/lib/early-access";

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  let passcode = "";
  let returnTo: string | null = null;
  if (contentType.includes("application/json")) {
    let body: Record<string, unknown> = {};
    try { body = await request.json() as Record<string, unknown>; } catch { /* invalid below */ }
    passcode = typeof body.passcode === "string" ? body.passcode : "";
    returnTo = safeAppReturnPath(body.return_to);
  } else {
    const form = await request.formData();
    passcode = typeof form.get("passcode") === "string" ? String(form.get("passcode")) : "";
    returnTo = safeAppReturnPath(form.get("return_to"));
  }
  const bindings = env as unknown as EarlyAccessBindings;
  if (!(await verifyEarlyAccessPasscode(passcode, bindings.EARLY_ACCESS_PASSWORD))) {
    return failure(request, returnTo, contentType, "invalid", 401);
  }

  const identity = await getAccessUser();
  if (identity) {
    const user = await upsertUser(identity);
    if (!(await grantEarlyAccess(user.id, "passcode"))) {
      return failure(request, returnTo, contentType, "revoked", 403);
    }
    const destination = admittedDestination(user.onboardedAt, returnTo);
    return contentType.includes("application/json")
      ? Response.json({ ok: true, redirect: destination })
      : Response.redirect(new URL(destination, request.url), 303);
  }

  const token = await signPendingEarlyAccess(bindings.EARLY_ACCESS_PASSWORD!);
  const complete = `${BASE_PATH}/early-access/complete${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ""}`;
  const destination = accessSignInPath(complete);
  const response = contentType.includes("application/json")
    ? Response.json({ ok: true, redirect: destination })
    : new Response(null, { status: 303, headers: { location: new URL(destination, request.url).toString() } });
  response.headers.append("set-cookie", pendingCookie(token, request));
  return response;
}

function failure(request: Request, returnTo: string | null, contentType: string, code: "invalid" | "revoked", status: number): Response {
  if (contentType.includes("application/json")) return Response.json({ error: "Early access could not be granted" }, { status });
  const url = new URL(`${BASE_PATH}/early-access`, request.url);
  if (returnTo) url.searchParams.set("return_to", returnTo);
  url.searchParams.set("unlock", code);
  return Response.redirect(url, 303);
}

function admittedDestination(onboardedAt: number | null, returnTo: string | null): string {
  const target = returnTo ?? `${BASE_PATH}/home`;
  return onboardedAt == null
    ? `${BASE_PATH}/onboarding?return_to=${encodeURIComponent(target)}`
    : target;
}

function pendingCookie(token: string, request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${EARLY_ACCESS_PENDING_COOKIE}=${token}; Path=${BASE_PATH || "/"}; Max-Age=${Math.floor(EARLY_ACCESS_PENDING_TTL_MS / 1000)}; HttpOnly; SameSite=Lax${secure}`;
}
