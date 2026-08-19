import { DurableObject } from "cloudflare:workers";
import { authorizePresence } from "../db/sessions";
import type { D1DatabaseLike } from "../db";
import { identityFromHeaders, localDevelopmentIdentity } from "../lib/identity";
import type { PresenceEvent } from "../lib/session-types";

type DurableObjectStubLike = { fetch(request: Request): Promise<Response> };
type DurableObjectNamespaceLike = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
};

export interface PresenceEnv {
  DB: D1DatabaseLike;
  SESSION_PRESENCE: DurableObjectNamespaceLike;
}

type SocketAttachment = { userId: string; displayName: string; connectionId: string };
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
    server.serializeAttachment({ userId, displayName, connectionId: crypto.randomUUID() });
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "presence.snapshot", onlineUserIds: this.onlineUserIds() } satisfies PresenceEvent));
    if (!wasOnline) this.broadcast({ type: "presence.changed", userId, online: true }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: AttachedWebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send("pong");
  }

  webSocketClose(socket: AttachedWebSocket): void {
    const attachment = socket.deserializeAttachment();
    if (attachment && this.socketsFor(attachment.userId).length === 0) {
      this.broadcast({ type: "presence.changed", userId: attachment.userId, online: false });
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
  const identity = identityFromHeaders(request.headers) ?? localDevelopmentIdentity(request.headers);
  if (!identity) return new Response("Authentication required", { status: 401 });
  const member = await authorizePresence(decodeURIComponent(presenceMatch[1]), identity.providerUserId, env.DB);
  if (!member) return new Response("Session not found", { status: 404 });

  const headers = new Headers(request.headers);
  headers.set("x-openfloor-user-id", member.userId);
  headers.set("x-openfloor-display-name", member.displayName);
  const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName(decodeURIComponent(presenceMatch[1])));
  return stub.fetch(new Request("https://presence.internal/connect", { method: "GET", headers }));
}
