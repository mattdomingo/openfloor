import { env } from "cloudflare:workers";
import { BASE_PATH } from "@/components/basePath";
import { getAccessUser } from "@/app/access-auth";
import { grantEarlyAccess } from "@/db/early-access";
import { upsertUser } from "@/db/sessions";
import { accessSignInPath, safeAppReturnPath } from "@/lib/access-paths";
import {
  EARLY_ACCESS_PENDING_COOKIE,
  hasEarlyAccess,
  verifyPendingEarlyAccess,
  type EarlyAccessBindings,
} from "@/lib/early-access";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = safeAppReturnPath(url.searchParams.get("return_to")) ?? `${BASE_PATH}/home`;
  const identity = await getAccessUser();
  if (!identity) {
    const complete = `${BASE_PATH}/early-access/complete?return_to=${encodeURIComponent(returnTo)}`;
    return Response.redirect(new URL(accessSignInPath(complete), request.url), 302);
  }

  const user = await upsertUser(identity);
  if (hasEarlyAccess(user)) return clearedRedirect(request, admittedDestination(user.onboardedAt, returnTo));

  const bindings = env as unknown as EarlyAccessBindings;
  const pending = cookieValue(request.headers.get("cookie"), EARLY_ACCESS_PENDING_COOKIE);
  if (await verifyPendingEarlyAccess(pending, bindings.EARLY_ACCESS_PASSWORD)) {
    if (await grantEarlyAccess(user.id, "passcode")) {
      return clearedRedirect(request, admittedDestination(user.onboardedAt, returnTo));
    }
    return clearedRedirect(request, earlyAccessError(returnTo, "revoked"));
  }
  return clearedRedirect(request, earlyAccessError(returnTo, "expired"));
}

function cookieValue(header: string | null, name: string): string | undefined {
  return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function admittedDestination(onboardedAt: number | null, returnTo: string): string {
  return onboardedAt == null
    ? `${BASE_PATH}/onboarding?return_to=${encodeURIComponent(returnTo)}`
    : returnTo;
}

function earlyAccessError(returnTo: string, code: "revoked" | "expired"): string {
  const params = new URLSearchParams({ return_to: returnTo, unlock: code });
  return `${BASE_PATH}/early-access?${params}`;
}

function clearedRedirect(request: Request, destination: string): Response {
  const response = new Response(null, {
    status: 303,
    headers: { location: new URL(destination, request.url).toString() },
  });
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  response.headers.append("set-cookie", `${EARLY_ACCESS_PENDING_COOKIE}=; Path=${BASE_PATH || "/"}; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
  return response;
}
