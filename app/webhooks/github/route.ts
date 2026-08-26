import { getGitHubAppConfig } from "@/db";
import { setUserGitHubInstallationStatus } from "@/db/github-installations";
import {
  findRepositoryWebhookTargets,
  recordGitHubWebhookDelivery,
  setRepositoryAvailability,
  touchRepositoryReview,
  updateRepositoryPullRequestState,
  updateRepositoryIdentity,
  updateRepositoryPushState,
} from "@/db/repositories";
import { endMergedSession } from "@/db/sessions";
import { verifyGitHubWebhookSignature } from "@/lib/github-state";
import { notifyFloorChanged, notifySessionEnded } from "@/lib/presence-server";

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
  if (event === "ping") return Response.json({ accepted: true, event });
  const deliveryId = request.headers.get("x-github-delivery")?.trim();
  if (!deliveryId || deliveryId.length > 200) return Response.json({ error: "Missing GitHub delivery ID" }, { status: 400 });
  let body: GitHubWebhookPayload;
  try {
    body = JSON.parse(new TextDecoder().decode(payload)) as GitHubWebhookPayload;
  } catch {
    return Response.json({ error: "Invalid webhook payload" }, { status: 400 });
  }
  const installationId = body.installation?.id == null ? null : String(body.installation.id);
  const repositoryId = body.repository?.id == null ? null : String(body.repository.id);
  const fresh = await recordGitHubWebhookDelivery(deliveryId, event, body.action ?? null, installationId, repositoryId);
  if (!fresh) return Response.json({ accepted: true, event, duplicate: true }, { status: 202 });
  if (event === "installation" && ["deleted", "suspend"].includes(body.action ?? "")) {
    await setUserGitHubInstallationStatus(installationId, "revoked");
  } else if (event === "installation" && ["created", "unsuspend", "new_permissions_accepted"].includes(body.action ?? "")) {
    await setUserGitHubInstallationStatus(installationId, "active");
  }
  const targets = await findRepositoryWebhookTargets(installationId, repositoryId);
  for (const target of targets) {
    let revision: number;
    if (event === "installation" && ["deleted", "suspend"].includes(body.action ?? "")) {
      revision = await setRepositoryAvailability(target.sessionId, "revoked");
    } else if (event === "installation" && ["created", "unsuspend", "new_permissions_accepted"].includes(body.action ?? "")) {
      revision = await setRepositoryAvailability(target.sessionId, "connected");
    } else if (event === "installation_repositories") {
      const removed = body.repositories_removed?.some((repository) => String(repository.id) === target.repositoryId);
      const added = body.repositories_added?.some((repository) => String(repository.id) === target.repositoryId);
      if (!removed && !added) continue;
      revision = await setRepositoryAvailability(target.sessionId, removed ? "inaccessible" : "connected");
    } else if (event === "repository" && body.action === "deleted") {
      revision = await setRepositoryAvailability(target.sessionId, "inaccessible");
    } else if (event === "repository" && body.repository) {
      revision = await updateRepositoryIdentity(target.sessionId, {
        owner: body.repository.owner?.login ?? body.repository.full_name?.split("/")[0] ?? "",
        name: body.repository.name ?? body.repository.full_name?.split("/")[1] ?? "",
        fullName: body.repository.full_name ?? "",
      });
    } else if (event === "push" && body.ref && body.after) {
      revision = await updateRepositoryPushState(
        target.sessionId, body.ref, body.after, target.baseBranch, target.candidateBranch, target.candidateSha, target.integrationRunId,
      );
    } else if (event === "pull_request" && body.pull_request?.head?.ref && body.pull_request.number && body.pull_request.node_id && body.pull_request.html_url) {
      const headRef = body.pull_request.head.ref;
      const merged = body.pull_request.merged === true;
      revision = await updateRepositoryPullRequestState(target.sessionId, {
        number: body.pull_request.number,
        nodeId: body.pull_request.node_id,
        url: body.pull_request.html_url,
        state: body.pull_request.state === "closed" ? "closed" : "open",
        draft: body.pull_request.draft !== false,
        merged,
        mergeCommitSha: body.pull_request.merge_commit_sha ?? null,
        headRef,
      });
      // Merging the candidate branch ends the session's lifecycle, same as
      // the app's own squash-merge route — whichever path merges it first.
      // No branch cleanup here: this only marks the session ended, leaving
      // cleanup_status 'pending' as updateRepositoryPullRequestState set it.
      if (merged && headRef === target.candidateBranch) {
        const ended = await endMergedSession(target.sessionId);
        if (ended) await notifySessionEnded(target.sessionId, ended.endedAt, "merged");
      }
    } else {
      revision = await touchRepositoryReview(target.sessionId);
    }
    await notifyFloorChanged(target.sessionId, revision, ["repository", "runs", "review"]);
  }
  return Response.json({ accepted: true, event }, { status: 202 });
}

type GitHubWebhookPayload = {
  action?: string;
  installation?: { id?: number | string };
  repository?: { id?: number | string; name?: string; full_name?: string; owner?: { login?: string } };
  repositories_removed?: Array<{ id?: number | string }>;
  repositories_added?: Array<{ id?: number | string }>;
  ref?: string;
  after?: string;
  pull_request?: { number?: number; node_id?: string; html_url?: string; state?: string; draft?: boolean; merged?: boolean; merge_commit_sha?: string; head?: { ref?: string } };
};
