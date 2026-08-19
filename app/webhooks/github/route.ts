import { getGitHubAppConfig } from "@/db";
import { verifyGitHubWebhookSignature } from "@/lib/github-state";

const MAX_WEBHOOK_BYTES = 1_000_000;

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "Webhook payload is too large" }, { status: 413 });
  }
  const payload = await request.arrayBuffer();
  if (payload.byteLength > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "Webhook payload is too large" }, { status: 413 });
  }
  const config = getGitHubAppConfig();
  const valid = await verifyGitHubWebhookSignature(
    payload,
    request.headers.get("x-hub-signature-256"),
    config.webhookSecret,
  );
  if (!valid) return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  const event = request.headers.get("x-github-event") ?? "unknown";
  return Response.json({ accepted: true, event }, { status: event === "ping" ? 200 : 202 });
}
