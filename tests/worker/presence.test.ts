import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSession, upsertUser } from "@/db/sessions";
import worker from "./entry";
import type { PresenceEvent } from "@/lib/session-types";

function nextMessage(socket: WebSocket): Promise<PresenceEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for presence event")), 2_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(event.data)) as PresenceEvent);
    }, { once: true });
  });
}

async function connect(stub: DurableObjectStub, userId: string, displayName: string) {
  const response = await stub.fetch("https://presence.internal/connect", {
    headers: {
      upgrade: "websocket",
      "x-openfloor-user-id": userId,
      "x-openfloor-display-name": displayName,
    },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing WebSocket");
  const initial = nextMessage(socket);
  socket.accept();
  return { socket, initial: await initial };
}

describe("SessionPresence Durable Object", () => {
  it("broadcasts presence and deduplicates multiple tabs", async () => {
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName("room-tabs"));
    const first = await connect(stub, "user-one", "One");
    expect(first.initial).toEqual({ type: "presence.snapshot", onlineUserIds: ["user-one"] });

    const second = await connect(stub, "user-one", "One");
    expect(second.initial).toEqual({ type: "presence.snapshot", onlineUserIds: ["user-one"] });

    const changed = nextMessage(first.socket);
    const other = await connect(stub, "user-two", "Two");
    expect(other.initial).toEqual({ type: "presence.snapshot", onlineUserIds: expect.arrayContaining(["user-one", "user-two"]) });
    await expect(changed).resolves.toEqual({ type: "presence.changed", userId: "user-two", online: true });

    first.socket.close(1000, "first tab closed");
    const offline = nextMessage(other.socket);
    second.socket.close(1000, "last tab closed");
    await expect(offline).resolves.toEqual({ type: "presence.changed", userId: "user-one", online: false });
    other.socket.close(1000, "done");
  });

  it("broadcasts membership changes and restores hibernated sockets", async () => {
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName("room-hibernation"));
    const first = await connect(stub, "user-one", "One");
    await evictDurableObject(stub);

    const notification = nextMessage(first.socket);
    await stub.fetch("https://presence.internal/members-changed", { method: "POST" });
    await expect(notification).resolves.toEqual({ type: "members.changed" });

    const second = await connect(stub, "user-two", "Two");
    expect(second.initial).toEqual({ type: "presence.snapshot", onlineUserIds: expect.arrayContaining(["user-one", "user-two"]) });
    first.socket.close(1000, "done");
    second.socket.close(1000, "done");
  });

  it("broadcasts session objective changes", async () => {
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName("room-session-change"));
    const first = await connect(stub, "user-one", "One");
    const notification = nextMessage(first.socket);
    const response = await stub.fetch("https://presence.internal/session-changed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "Shared next step", updatedAt: 42 }),
    });
    expect(response.status).toBe(204);
    await expect(notification).resolves.toEqual({ type: "session.changed", objective: "Shared next step", updatedAt: 42 });
    first.socket.close(1000, "done");
  });

  it("broadcasts floor revisions and changed domains", async () => {
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName("room-floor-change"));
    const first = await connect(stub, "user-one", "One");
    const notification = nextMessage(first.socket);
    const response = await stub.fetch("https://presence.internal/floor-changed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 7, domains: ["agents", "queue"] }),
    });
    expect(response.status).toBe(204);
    await expect(notification).resolves.toEqual({ type: "floor.changed", revision: 7, domains: ["agents", "queue"] });
    first.socket.close(1000, "done");
  });
});

describe("authenticated presence upgrade", () => {
  it("rejects unauthenticated and non-member requests before the object", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-owner",
      email: "owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Protected", objective: null }, env.DB);
    const url = `http://localhost/app/api/sessions/${created.session.id}/presence`;
    const anonymous = await worker.fetch(new Request(url, { headers: { upgrade: "websocket" } }), env);
    expect(anonymous.status).toBe(401);

    const outsider = await worker.fetch(new Request(url, { headers: {
      host: "localhost",
      upgrade: "websocket",
      "x-openfloor-dev-user-id": "chatgpt-outsider",
      "x-openfloor-dev-user-email": "outsider@example.com",
    } }), env);
    expect(outsider.status).toBe(404);

    const accepted = await worker.fetch(new Request(url, { headers: {
      host: "localhost",
      upgrade: "websocket",
      "x-openfloor-dev-user-id": "chatgpt-owner",
      "x-openfloor-dev-user-email": "owner@example.com",
    } }), env);
    expect(accepted.status).toBe(101);
    accepted.webSocket?.accept();
    accepted.webSocket?.close(1000, "done");
  });
});
