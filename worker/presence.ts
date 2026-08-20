import { DurableObject } from "cloudflare:workers";
import { authorizePresence } from "../db/sessions";
import type { D1DatabaseLike } from "../db";
import {
  cloudflareAccessIdentity,
  localDevelopmentIdentity,
  type IdentityEnvironment,
} from "../lib/identity";
import type { PresenceEvent, TypingDraft, TypingUpdate } from "../lib/session-types";
import type { FloorDomain, RunActivityEvent } from "../lib/floor-types";

type DurableObjectStubLike = { fetch(request: Request): Promise<Response> };
type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
};

export interface PresenceEnv extends IdentityEnvironment {
  DB: D1DatabaseLike;
  SESSION_PRESENCE: DurableObjectNamespaceLike;
}

const MAX_DRAFT_LENGTH = 4_000;

type SocketAttachment = {
  userId: string;
  displayName: string;
  connectionId: string;
  draft?: string;
  typing?: boolean;
  draftUpdatedAt?: number;
};
type AttachedWebSocket = WebSocket & {
  serializeAttachment(value: SocketAttachment): void;
  deserializeAttachment(): SocketAttachment | null;
};

export class SessionPresence extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect") return this.acceptConnection(request);
    if (url.pathname === "/members-changed" && request.method === "POST") {
      this.broadcast({ type: "members.changed" });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/session-changed" && request.method === "POST") {
      const body = (await request.json()) as { objective?: unknown; updatedAt?: unknown };
      if ((body.objective !== null && typeof body.objective !== "string") || typeof body.updatedAt !== "number") {
        return new Response("Invalid session change", { status: 400 });
      }
      this.broadcast({ type: "session.changed", objective: body.objective ?? null, updatedAt: body.updatedAt });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/session-ended" && request.method === "POST") {
      const body = (await request.json()) as { endedAt?: unknown };
      if (typeof body.endedAt !== "number") return new Response("Invalid session end", { status: 400 });
      // Sockets stay open on purpose: ended sessions remain readable, and the
      // server-side write guard is the enforcement.
      this.broadcast({ type: "session.ended", endedAt: body.endedAt });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/floor-changed" && request.method === "POST") {
      const body = (await request.json()) as { revision?: unknown; domains?: unknown };
      const allowed = new Set<FloorDomain>(["agents", "assignments", "messages", "queue", "repository", "runs", "review"]);
      if (typeof body.revision !== "number" || !Array.isArray(body.domains) || body.domains.some((domain) => typeof domain !== "string" || !allowed.has(domain as FloorDomain))) {
        return new Response("Invalid floor change", { status: 400 });
      }
      this.broadcast({ type: "floor.changed", revision: body.revision, domains: body.domains as FloorDomain[] });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/run-activity" && request.method === "POST") {
      const body = (await request.json()) as { runId?: unknown; agentId?: unknown; events?: unknown };
      const validEvent = (event: unknown): event is RunActivityEvent => {
        if (!event || typeof event !== "object") return false;
        const candidate = event as Record<string, unknown>;
        return typeof candidate.id === "string" && typeof candidate.runId === "string"
          && typeof candidate.sequence === "number" && typeof candidate.kind === "string"
          && typeof candidate.detail === "string" && candidate.detail.length <= 2_000
          && typeof candidate.createdAt === "number";
      };
      if (typeof body.runId !== "string" || typeof body.agentId !== "string"
        || !Array.isArray(body.events) || body.events.length > 50 || !body.events.every(validEvent)) {
        return new Response("Invalid run activity", { status: 400 });
      }
      this.broadcast({ type: "run.activity", runId: body.runId, agentId: body.agentId, events: body.events });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/disconnect-user" && request.method === "POST") {
      const body = (await request.json()) as { userId?: string };
      if (body.userId) {
        for (const socket of this.socketsFor(body.userId)) socket.close(4001, "Membership ended");
      }
      return new Response(null, { status: 204 });
    }
    return new Response("Not found", { status: 404 });
  }

  private acceptConnection(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const userId = request.headers.get("x-openfloor-user-id");
    const displayName = request.headers.get("x-openfloor-display-name");
    if (!userId || !displayName) return new Response("Unauthorized", { status: 401 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1] as AttachedWebSocket;
    const wasOnline = this.socketsFor(userId).length > 0;
    server.serializeAttachment({ userId, displayName, connectionId: crypto.randomUUID(), draft: "", typing: false, draftUpdatedAt: 0 });
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({
      type: "presence.snapshot",
      onlineUserIds: this.onlineUserIds(),
      typingDrafts: this.typingDrafts(),
    } satisfies PresenceEvent));
    if (!wasOnline) this.broadcast({ type: "presence.changed", userId, online: true }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: AttachedWebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") {
      socket.send("pong");
      return;
    }
    if (typeof message !== "string") {
      socket.send(JSON.stringify({ type: "error", code: "typing.invalid" } satisfies PresenceEvent));
      return;
    }

    let update: TypingUpdate;
    try {
      update = JSON.parse(message) as TypingUpdate;
    } catch {
      socket.send(JSON.stringify({ type: "error", code: "typing.invalid" } satisfies PresenceEvent));
      return;
    }
    if (update.type !== "typing.update" || typeof update.text !== "string" || typeof update.typing !== "boolean" || update.text.length > MAX_DRAFT_LENGTH) {
      socket.send(JSON.stringify({ type: "error", code: "typing.invalid" } satisfies PresenceEvent));
      return;
    }

    const attachment = socket.deserializeAttachment();
    if (!attachment) return;
    socket.serializeAttachment({
      ...attachment,
      draft: update.text,
      typing: update.text.length > 0 && update.typing,
      draftUpdatedAt: this.nextDraftUpdatedAt(),
    });
    this.broadcastUserDraft(attachment.userId, attachment.displayName);
  }

  webSocketClose(socket: AttachedWebSocket): void {
    const attachment = socket.deserializeAttachment();
    if (attachment) {
      if (attachment.draft || attachment.typing) this.broadcastUserDraft(attachment.userId, attachment.displayName);
      if (this.socketsFor(attachment.userId).length === 0) {
        this.broadcast({ type: "presence.changed", userId: attachment.userId, online: false });
      }
    }
  }

  webSocketError(socket: AttachedWebSocket): void {
    this.webSocketClose(socket);
  }

  private sockets(): AttachedWebSocket[] {
    return this.ctx.getWebSockets() as AttachedWebSocket[];
  }

  private socketsFor(userId: string): AttachedWebSocket[] {
    return this.sockets().filter((socket) => socket.readyState === WebSocket.OPEN && socket.deserializeAttachment()?.userId === userId);
  }

  private onlineUserIds(): string[] {
    return [...new Set(this.sockets().filter((socket) => socket.readyState === WebSocket.OPEN).map((socket) => socket.deserializeAttachment()?.userId).filter((id): id is string => Boolean(id)))];
  }

  private typingDraftFor(userId: string, fallbackDisplayName: string): TypingDraft {
    const attachments = this.socketsFor(userId)
      .map((socket) => socket.deserializeAttachment())
      .filter((attachment): attachment is SocketAttachment => Boolean(attachment));
    const active = attachments.filter((attachment) => attachment.typing && attachment.draft);
    const candidates = active.length > 0 ? active : attachments.filter((attachment) => attachment.draft);
    const selected = candidates.sort((a, b) => (b.draftUpdatedAt ?? 0) - (a.draftUpdatedAt ?? 0))[0];
    return {
      userId,
      displayName: selected?.displayName ?? fallbackDisplayName,
      text: selected?.draft ?? "",
      typing: active.length > 0,
      updatedAt: Math.max(0, ...attachments.map((attachment) => attachment.draftUpdatedAt ?? 0)),
    };
  }

  private nextDraftUpdatedAt(): number {
    return Math.max(
      Date.now(),
      ...this.sockets().map((socket) => (socket.deserializeAttachment()?.draftUpdatedAt ?? 0) + 1),
    );
  }

  private typingDrafts(): TypingDraft[] {
    const users = new Map<string, string>();
    for (const socket of this.sockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = socket.deserializeAttachment();
      if (attachment) users.set(attachment.userId, attachment.displayName);
    }
    return [...users].map(([userId, displayName]) => this.typingDraftFor(userId, displayName)).filter((draft) => draft.text || draft.typing);
  }

  private broadcastUserDraft(userId: string, displayName: string): void {
    this.broadcast({ type: "typing.changed", draft: this.typingDraftFor(userId, displayName) });
  }

  private broadcast(event: PresenceEvent, except?: WebSocket): void {
    const payload = JSON.stringify(event);
    for (const socket of this.sockets()) {
      if (socket !== except && socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }
}

export async function handlePresenceRequest(request: Request, env: PresenceEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const presenceMatch = url.pathname.match(/^\/(?:app\/)?api\/sessions\/([^/]+)\/presence$/);
  if (!presenceMatch) return null;
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426 });
  }
  const identity = localDevelopmentIdentity(request.headers, env)
    ?? await cloudflareAccessIdentity(request.headers, env);
  if (!identity) return new Response("Authentication required", { status: 401 });
  const member = await authorizePresence(decodeURIComponent(presenceMatch[1]), identity.providerUserId, env.DB);
  if (!member) return new Response("Session not found", { status: 404 });

  const headers = new Headers(request.headers);
  headers.set("x-openfloor-user-id", member.userId);
  headers.set("x-openfloor-display-name", member.displayName);
  const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName(decodeURIComponent(presenceMatch[1])));
  return stub.fetch(new Request("https://presence.internal/connect", { method: "GET", headers }));
}
