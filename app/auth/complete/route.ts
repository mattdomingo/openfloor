import { BASE_PATH } from "@/components/basePath";
import { safeAppReturnPath } from "@/lib/access-paths";

export const dynamic = "force-dynamic";

// The one page path Cloudflare Access still protects: every sign-in flow
// (protectedAccessPath) anchors on it, so completing authentication lands
// here with the CF_Authorization cookie freshly set, and this immediately
// bounces to the requested page — which lives outside Access and reads that
// cookie via cloudflareAccessIdentity. Serving a redirect and nothing else
// keeps the hosted Access screen off every real page.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeAppReturnPath(url.searchParams.get("return_to")) ?? `${BASE_PATH}/home`;
  return Response.redirect(new URL(returnTo, request.url), 303);
}
