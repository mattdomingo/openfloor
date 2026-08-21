import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createSession, currentMonth, endSession, upsertUser } from "@/db/sessions";
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
    expect(first.initial).toEqual({ type: "presence.snapshot", onlineUserIds: ["user-one"], typingDrafts: [] });

    const second = await connect(stub, "user-one", "One");
    expect(second.initial).toEqual({ type: "presence.snapshot", onlineUserIds: ["user-one"], typingDrafts: [] });

    const changed = nextMessage(first.socket);
    const other = await connect(stub, "user-two", "Two");
    expect(other.initial).toEqual({ type: "presence.snapshot", onlineUserIds: expect.arrayContaining(["user-one", "user-two"]), typingDrafts: [] });
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
    expect(second.initial).toEqual({ type: "presence.snapshot", onlineUserIds: expect.arrayContaining(["user-one", "user-two"]), typingDrafts: [] });
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

  it("broadcasts the session ending without closing sockets", async () => {
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName("room-session-ended"));
    const first = await connect(stub, "user-one", "One");
    const notification = nextMessage(first.socket);
    const response = await stub.fetch("https://presence.internal/session-ended", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endedAt: 99, reason: "owner" }),
    });
    expect(response.status).toBe(204);
    await expect(notification).resolves.toEqual({ type: "session.ended", endedAt: 99, reason: "owner" });
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
    const invalid = await stub.fetch("https://presence.internal/session-ended", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endedAt: "soon" }),
    });
    expect(invalid.status).toBe(400);
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

  it("broadcasts ephemeral drafts and preserves a draft across hibernation", async () => {
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName("room-drafts"));
    const author = await connect(stub, "user-one", "One");
    const observer = await connect(stub, "user-two", "Two");
    const authorChanged = nextMessage(author.socket);
    const observerChanged = nextMessage(observer.socket);
    author.socket.send(JSON.stringify({ type: "typing.update", text: "Working together", typing: true }));
    const expected = expect.objectContaining({
      type: "typing.changed",
      draft: expect.objectContaining({ userId: "user-one", displayName: "One", text: "Working together", typing: true }),
    });
    await expect(authorChanged).resolves.toEqual(expected);
    await expect(observerChanged).resolves.toEqual(expected);

    await evictDurableObject(stub);
    const restored = await connect(stub, "user-three", "Three");
    expect(restored.initial).toEqual(expect.objectContaining({
      type: "presence.snapshot",
      typingDrafts: [expect.objectContaining({ userId: "user-one", text: "Working together", typing: true })],
    }));
    author.socket.close(1000, "done");
    observer.socket.close(1000, "done");
    restored.socket.close(1000, "done");
  });

  it("keeps another tab's draft when one tab closes", async () => {
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName("room-draft-tabs"));
    const first = await connect(stub, "user-one", "One");
    const second = await connect(stub, "user-one", "One");
    const observer = await connect(stub, "user-two", "Two");

    const firstUpdate = nextMessage(observer.socket);
    first.socket.send(JSON.stringify({ type: "typing.update", text: "First tab", typing: true }));
    await firstUpdate;
    const secondUpdate = nextMessage(observer.socket);
    second.socket.send(JSON.stringify({ type: "typing.update", text: "Second tab", typing: true }));
    await expect(secondUpdate).resolves.toEqual(expect.objectContaining({ draft: expect.objectContaining({ text: "Second tab", typing: true }) }));

    const restored = nextMessage(observer.socket);
    second.socket.close(1000, "second tab closed");
    await expect(restored).resolves.toEqual(expect.objectContaining({ draft: expect.objectContaining({ text: "First tab", typing: true }) }));
    first.socket.close(1000, "done");
    observer.socket.close(1000, "done");
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

  it("rejects the upgrade with close code 4003 once owner hours are exhausted", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-quota-owner",
      email: "quota-owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Metered", objective: null }, env.DB);
    await env.DB.prepare("INSERT INTO usage_months (owner_user_id, month, seconds) VALUES (?, ?, ?)")
      .bind(owner.id, currentMonth(), 30 * 3600)
      .run();

    const response = await worker.fetch(new Request(`http://localhost/app/api/sessions/${created.session.id}/presence`, { headers: {
      host: "localhost",
      upgrade: "websocket",
      "x-openfloor-dev-user-id": "chatgpt-quota-owner",
      "x-openfloor-dev-user-email": "quota-owner@example.com",
    } }), env);
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing WebSocket");
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener("close", ((event: CloseEvent) => resolve(event)) as EventListener, { once: true });
    });
    socket.accept();
    const event = await closed;
    expect(event.code).toBe(4003);
  });

  it("books active seconds to the owner and session when the last socket closes", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-meter-owner",
      email: "meter-owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Meter", objective: null }, env.DB);
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName(created.session.id));
    const response = await stub.fetch("https://presence.internal/connect", { headers: {
      upgrade: "websocket",
      "x-openfloor-user-id": owner.id,
      "x-openfloor-display-name": "Owner",
      "x-openfloor-meter-owner-id": owner.id,
      "x-openfloor-meter-session-id": created.session.id,
    } });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing WebSocket");
    socket.accept();
    socket.close(1000, "done");

    await vi.waitFor(async () => {
      const usage = await env.DB.prepare("SELECT seconds FROM usage_months WHERE owner_user_id = ? AND month = ?")
        .bind(owner.id, currentMonth())
        .first<{ seconds: number }>();
      expect(usage).not.toBeNull();
      expect(usage!.seconds).toBeGreaterThanOrEqual(0);
      const session = await env.DB.prepare("SELECT active_seconds AS activeSeconds FROM sessions WHERE id = ?")
        .bind(created.session.id)
        .first<{ activeSeconds: number }>();
      expect(session!.activeSeconds).toBe(usage!.seconds);
    });
  });

  it("ignores forged meter headers on an ended session (no usage booked to the forged owner)", async () => {
    const attacker = await upsertUser({
      providerUserId: "chatgpt-spoof-attacker",
      email: "spoof-attacker@example.com",
      displayName: "Attacker",
      fullName: "Attacker",
    }, env.DB);
    const victim = await upsertUser({
      providerUserId: "chatgpt-spoof-victim",
      email: "spoof-victim@example.com",
      displayName: "Victim",
      fullName: "Victim",
    }, env.DB);
    const created = await createSession(attacker.id, { title: "Ended", objective: null }, env.DB);
    await endSession(created.session.id, attacker.id, "owner", env.DB);

    const response = await worker.fetch(new Request(`http://localhost/app/api/sessions/${created.session.id}/presence`, { headers: {
      host: "localhost",
      upgrade: "websocket",
      "x-openfloor-dev-user-id": "chatgpt-spoof-attacker",
      "x-openfloor-dev-user-email": "spoof-attacker@example.com",
      // Forged: on the live path these get overwritten by the real owner's
      // id, but the ended-session path skips the gate (and used to skip
      // stripping too) — this must not reach the DO at all.
      "x-openfloor-meter-owner-id": victim.id,
      "x-openfloor-meter-session-id": created.session.id,
    } }), env);
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing WebSocket");
    socket.accept();
    socket.close(1000, "done");

    // Give any (incorrect) flush a moment to land, then assert nothing did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const victimUsage = await env.DB.prepare("SELECT seconds FROM usage_months WHERE owner_user_id = ? AND month = ?")
      .bind(victim.id, currentMonth())
      .first<{ seconds: number }>();
    expect(victimUsage).toBeNull();
    const sessionRow = await env.DB.prepare("SELECT active_seconds AS activeSeconds FROM sessions WHERE id = ?")
      .bind(created.session.id)
      .first<{ activeSeconds: number }>();
    expect(sessionRow!.activeSeconds).toBe(0);
  });

  it("overwrites forged meter headers with the true owner on a live session", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-spoof-owner",
      email: "spoof-owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const impersonated = await upsertUser({
      providerUserId: "chatgpt-spoof-impersonated",
      email: "spoof-impersonated@example.com",
      displayName: "Impersonated",
      fullName: "Impersonated",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Live", objective: null }, env.DB);

    const response = await worker.fetch(new Request(`http://localhost/app/api/sessions/${created.session.id}/presence`, { headers: {
      host: "localhost",
      upgrade: "websocket",
      "x-openfloor-dev-user-id": "chatgpt-spoof-owner",
      "x-openfloor-dev-user-email": "spoof-owner@example.com",
      "x-openfloor-meter-owner-id": impersonated.id,
      "x-openfloor-meter-session-id": created.session.id,
    } }), env);
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing WebSocket");
    socket.accept();
    socket.close(1000, "done");

    await vi.waitFor(async () => {
      const ownerUsage = await env.DB.prepare("SELECT seconds FROM usage_months WHERE owner_user_id = ? AND month = ?")
        .bind(owner.id, currentMonth())
        .first<{ seconds: number }>();
      expect(ownerUsage).not.toBeNull();
    });
    const impersonatedUsage = await env.DB.prepare("SELECT seconds FROM usage_months WHERE owner_user_id = ? AND month = ?")
      .bind(impersonated.id, currentMonth())
      .first<{ seconds: number }>();
    expect(impersonatedUsage).toBeNull();
  });
});
