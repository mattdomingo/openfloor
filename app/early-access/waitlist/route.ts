import { env } from "cloudflare:workers";
import { BASE_PATH } from "@/components/basePath";
import { syncWaitlistRecordToSheet, upsertWaitlistEntry } from "@/db/early-access";
import { EARLY_ACCESS_CONSENT_VERSION, type EarlyAccessBindings } from "@/lib/early-access";
import { safeAppReturnPath } from "@/lib/access-paths";
import { parseEarlyAccessWaitlistInput } from "@/lib/validation";

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  let raw: unknown;
  let returnTo: string | null = null;
  if (contentType.includes("application/json")) {
    try { raw = await request.json(); } catch { raw = null; }
    returnTo = safeAppReturnPath((raw as Record<string, unknown> | null)?.return_to);
  } else {
    const form = await request.formData();
    raw = { name: form.get("name"), email: form.get("email") };
    returnTo = safeAppReturnPath(form.get("return_to"));
  }
  const input = parseEarlyAccessWaitlistInput(raw);
  if (!input) {
    return contentType.includes("application/json")
      ? Response.json({ error: "Invalid waitlist submission" }, { status: 400 })
      : Response.redirect(earlyAccessUrl(request, returnTo, "waitlist=invalid"), 303);
  }

  const record = await upsertWaitlistEntry({ ...input, consentVersion: EARLY_ACCESS_CONSENT_VERSION });
  await syncWaitlistRecordToSheet(record, (env as unknown as { DB: Parameters<typeof syncWaitlistRecordToSheet>[1] }).DB, env as unknown as EarlyAccessBindings);

  return contentType.includes("application/json")
    ? Response.json({ ok: true })
    : Response.redirect(earlyAccessUrl(request, returnTo, "waitlist=joined"), 303);
}

function earlyAccessUrl(request: Request, returnTo: string | null, state: string): URL {
  const url = new URL(`${BASE_PATH}/early-access`, request.url);
  if (returnTo) url.searchParams.set("return_to", returnTo);
  const [key, value] = state.split("=");
  url.searchParams.set(key, value);
  return url;
}
