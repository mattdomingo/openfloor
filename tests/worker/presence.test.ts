import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { acceptInvite, createSession, currentMonth, endSession, removeMember, upsertUser } from "@/db/sessions";
import worker from "./entry";
import type { PresenceEvent } from "@/lib/session-types";
import type { SessionPresence } from "@/worker/presence";

function nextMessage(socket: WebSocket): Promise<PresenceEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for presence event")), 2_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(event.data)) as PresenceEvent);
    }, { once: true });
  });
}

function nextRawMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for raw message")), 2_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(String(event.data));
    }, { once: true });
  });
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for close event")), 2_000);
    socket.addEventListener("close", ((event: CloseEvent) => {
      clearTimeout(timer);
      resolve(event);
    }) as EventListener, { once: true });
  });
}

// Test-only access to the DO's internal metering state: real production code
// never reaches in like this, but the alternative — waiting out real
// 15/30-minute intervals — is not workable in a test suite.
type MeteringAttachment = { lastActivityAt: number; [key: string]: unknown };
type MeteredSocket = WebSocket & {
  serializeAttachment(value: MeteringAttachment): void;
  deserializeAttachment(): MeteringAttachment | null;
};

async function setClockStart(stub: DurableObjectStub, timestamp: number): Promise<void> {
  await runInDurableObject(stub as unknown as DurableObjectStub<SessionPresence>, (_instance, state) => state.storage.put("clockStart", timestamp));
}

async function getClockStart(stub: DurableObjectStub): Promise<number | undefined> {
  return runInDurableObject(stub as unknown as DurableObjectStub<SessionPresence>, (_instance, state) => state.storage.get<number>("clockStart"));
}

async function getScheduledAlarm(stub: DurableObjectStub): Promise<number | null> {
  return runInDurableObject(stub as unknown as DurableObjectStub<SessionPresence>, (_instance, state) => state.storage.getAlarm());
}

async function backdateAllLastActivity(stub: DurableObjectStub, timestamp: number): Promise<void> {
  await runInDurableObject(stub as unknown as DurableObjectStub<SessionPresence>, (_instance, state) => {
    for (const socket of state.getWebSockets() as MeteredSocket[]) {
      const attachment = socket.deserializeAttachment();
      if (attachment) socket.serializeAttachment({ ...attachment, lastActivityAt: timestamp });
    }
  });
}

async function readUsageSeconds(ownerId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT seconds FROM usage_months WHERE owner_user_id = ? AND month = ?")
    .bind(ownerId, currentMonth())
    .first<{ seconds: number }>();
  return row?.seconds ?? 0;
}

async function connectMetered(stub: DurableObjectStub, userId: string, ownerId: string, sessionId: string) {
  const response = await stub.fetch("https://presence.internal/connect", {
    headers: {
      upgrade: "websocket",
      "x-openfloor-user-id": userId,
      "x-openfloor-display-name": userId,
      "x-openfloor-meter-owner-id": ownerId,
      "x-openfloor-meter-session-id": sessionId,
    },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing WebSocket");
  socket.accept();
  return socket;
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

  it("broadcasts a session lock without closing sockets", async () => {
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName("room-session-locked"));
    const first = await connect(stub, "user-one", "One");
    const notification = nextMessage(first.socket);
    const response = await stub.fetch("https://presence.internal/session-locked", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lockedAt: 55 }),
    });
    expect(response.status).toBe(204);
    await expect(notification).resolves.toEqual({ type: "session.locked", lockedAt: 55 });
    expect(first.socket.readyState).toBe(WebSocket.OPEN);

    const unlockNotification = nextMessage(first.socket);
    await stub.fetch("https://presence.internal/session-locked", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lockedAt: null }),
    });
    await expect(unlockNotification).resolves.toEqual({ type: "session.locked", lockedAt: null });

    const invalid = await stub.fetch("https://presence.internal/session-locked", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lockedAt: "soon" }),
    });
    expect(invalid.status).toBe(400);
    first.socket.close(1000, "done");
  });

  it("closes a member's sockets with the matching code for a plain vs. owner-initiated disconnect", async () => {
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName("room-disconnect"));
    const plain = await connect(stub, "user-plain", "Plain");
    const removed = await connect(stub, "user-removed", "Removed");

    const plainClose = nextClose(plain.socket);
    await stub.fetch("https://presence.internal/disconnect-user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-plain" }),
    });
    expect((await plainClose).code).toBe(4001);

    const removedClose = nextClose(removed.socket);
    // Distinct from the plain 4001 above so the client can tell the removed
    // person what actually happened instead of silently bouncing them home.
    await stub.fetch("https://presence.internal/disconnect-user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user-removed", reason: "removed" }),
    });
    expect((await removedClose).code).toBe(4005);
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

  it("refuses the presence upgrade for a removed member, same as a non-member", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-remove-presence-owner",
      email: "remove-presence-owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const member = await upsertUser({
      providerUserId: "chatgpt-remove-presence-member",
      email: "remove-presence-member@example.com",
      displayName: "Member",
      fullName: "Member",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Removable", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);
    await removeMember(created.session.id, owner.id, member.id, env.DB);

    const response = await worker.fetch(new Request(`http://localhost/app/api/sessions/${created.session.id}/presence`, { headers: {
      host: "localhost",
      upgrade: "websocket",
      "x-openfloor-dev-user-id": "chatgpt-remove-presence-member",
      "x-openfloor-dev-user-email": "remove-presence-member@example.com",
    } }), env);
    expect(response.status).toBe(404);
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

describe("hour-quota gate fails closed", () => {
  it("throws rather than connecting ungated and unmetered when a session has no owner row", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-no-owner-owner",
      email: "no-owner-owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const member = await upsertUser({
      providerUserId: "chatgpt-no-owner-member",
      email: "no-owner-member@example.com",
      displayName: "Member",
      fullName: "Member",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Ownerless", objective: null }, env.DB);
    await acceptInvite(created.inviteId, member.id, env.DB);
    // Simulate the invariant breaking: the caller (member) still has a
    // membership row, but the owner's is gone, so getOwnerHourQuota's
    // INNER JOIN finds nothing to gate or meter against.
    await env.DB.prepare("DELETE FROM session_members WHERE session_id = ? AND role = 'owner'")
      .bind(created.session.id)
      .run();

    await expect(worker.fetch(new Request(`http://localhost/app/api/sessions/${created.session.id}/presence`, {
      headers: {
        host: "localhost",
        upgrade: "websocket",
        "x-openfloor-dev-user-id": "chatgpt-no-owner-member",
        "x-openfloor-dev-user-email": "no-owner-member@example.com",
      },
    }), env)).rejects.toThrow(/getOwnerHourQuota returned no row/);
  });
});

describe("metering stops when a session ends", () => {
  it("books time once and clears the clock when /session-ended arrives", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-end-owner",
      email: "end-owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Ending", objective: null }, env.DB);
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName(created.session.id));
    const response = await stub.fetch("https://presence.internal/connect", { headers: {
      upgrade: "websocket",
      "x-openfloor-user-id": owner.id,
      "x-openfloor-display-name": "Owner",
      "x-openfloor-meter-owner-id": owner.id,
      "x-openfloor-meter-session-id": created.session.id,
    } });
    expect(response.status).toBe(101);
    response.webSocket?.accept(); // stays open — occupancy does not hit zero on its own

    const ended = await stub.fetch("https://presence.internal/session-ended", {
      method: "POST",
      body: JSON.stringify({ endedAt: Date.now(), reason: "owner" }),
    });
    expect(ended.status).toBe(204);

    const usage = await env.DB.prepare("SELECT seconds FROM usage_months WHERE owner_user_id = ? AND month = ?")
      .bind(owner.id, currentMonth())
      .first<{ seconds: number }>();
    expect(usage).not.toBeNull();
    const bookedSeconds = usage!.seconds;

    const clockStart = await runInDurableObject(stub as unknown as DurableObjectStub<SessionPresence>, (_instance, state) => state.storage.get("clockStart"));
    expect(clockStart).toBeUndefined();
    const meterOwnerId = await runInDurableObject(stub as unknown as DurableObjectStub<SessionPresence>, (_instance, state) => state.storage.get("meterOwnerId"));
    expect(meterOwnerId).toBeUndefined();

    // A subsequent alarm (simulating one that was already in flight, or a
    // stray re-arm) must not book anything further: flushUsage's own
    // !clockStart early return is the backstop once clockStart is gone.
    await runInDurableObject(stub as unknown as DurableObjectStub<SessionPresence>, (instance) => instance.alarm());
    const usageAfterAlarm = await env.DB.prepare("SELECT seconds FROM usage_months WHERE owner_user_id = ? AND month = ?")
      .bind(owner.id, currentMonth())
      .first<{ seconds: number }>();
    expect(usageAfterAlarm!.seconds).toBe(bookedSeconds);
  });

  it("alarm backstop stops metering when the /session-ended fetch never arrived", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-backstop-owner",
      email: "backstop-owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Backstopped", objective: null }, env.DB);
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName(created.session.id));
    const response = await stub.fetch("https://presence.internal/connect", { headers: {
      upgrade: "websocket",
      "x-openfloor-user-id": owner.id,
      "x-openfloor-display-name": "Owner",
      "x-openfloor-meter-owner-id": owner.id,
      "x-openfloor-meter-session-id": created.session.id,
    } });
    expect(response.status).toBe(101);
    response.webSocket?.accept();

    // The session ends in D1, but (unlike the test above) the DO is never
    // told — simulating the /session-ended fetch failing after the D1 write.
    await endSession(created.session.id, owner.id, "owner", env.DB);

    await runInDurableObject(stub as unknown as DurableObjectStub<SessionPresence>, (instance) => instance.alarm());

    const usage = await env.DB.prepare("SELECT seconds FROM usage_months WHERE owner_user_id = ? AND month = ?")
      .bind(owner.id, currentMonth())
      .first<{ seconds: number }>();
    expect(usage).not.toBeNull();
    const clockStart = await runInDurableObject(stub as unknown as DurableObjectStub<SessionPresence>, (_instance, state) => state.storage.get("clockStart"));
    expect(clockStart).toBeUndefined();
    const alarmTime = await runInDurableObject(stub as unknown as DurableObjectStub<SessionPresence>, (_instance, state) => state.storage.getAlarm());
    expect(alarmTime).toBeNull();
  });
});

describe("idle timeout and honest billing", () => {
  it("a periodic alarm books elapsed time and re-arms while a socket is active", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-idle-active-owner",
      email: "idle-active-owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Active", objective: null }, env.DB);
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName(created.session.id));
    const socket = await connectMetered(stub, owner.id, owner.id, created.session.id);

    const fiveMinutesAgo = Date.now() - 5 * 60_000;
    await setClockStart(stub, fiveMinutesAgo);

    const ran = await runDurableObjectAlarm(stub as unknown as DurableObjectStub<SessionPresence>);
    expect(ran).toBe(true);

    const seconds = await readUsageSeconds(owner.id);
    expect(seconds).toBeGreaterThanOrEqual(295);
    expect(seconds).toBeLessThanOrEqual(305);

    const newClockStart = await getClockStart(stub);
    expect(newClockStart).toBeGreaterThan(fiveMinutesAgo);
    const alarmAt = await getScheduledAlarm(stub);
    expect(alarmAt).not.toBeNull();

    socket.close(1000, "cleanup");
  });

  it("closes an idle socket with 4004 and books only up to its last real activity", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-idle-close-owner",
      email: "idle-close-owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Idle", objective: null }, env.DB);
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName(created.session.id));
    const socket = await connectMetered(stub, owner.id, owner.id, created.session.id);
    const closed = nextClose(socket);

    const now = Date.now();
    await setClockStart(stub, now - 40 * 60_000); // "connected" 40 minutes ago
    await backdateAllLastActivity(stub, now - 35 * 60_000); // idle for the last 35 minutes

    const ran = await runDurableObjectAlarm(stub as unknown as DurableObjectStub<SessionPresence>);
    expect(ran).toBe(true);

    const event = await closed;
    expect(event.code).toBe(4004);

    // Booked only the 5 minutes between clockStart and the last real
    // activity — not the full 40 minutes the socket was technically open.
    const seconds = await readUsageSeconds(owner.id);
    expect(seconds).toBeGreaterThanOrEqual(295);
    expect(seconds).toBeLessThanOrEqual(310);
  });

  it("a ping refreshes the idle deadline and keeps an active socket connected", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-idle-ping-owner",
      email: "idle-ping-owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Pinged", objective: null }, env.DB);
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName(created.session.id));
    const socket = await connectMetered(stub, owner.id, owner.id, created.session.id);

    await setClockStart(stub, Date.now() - 10 * 60_000);
    // Refresh real activity right before the alarm fires, as the client's
    // input-gated heartbeat does.
    const pong = nextRawMessage(socket);
    socket.send("ping");
    expect(await pong).toBe("pong");

    let closedEarly = false;
    socket.addEventListener("close", () => { closedEarly = true; });

    const ran = await runDurableObjectAlarm(stub as unknown as DurableObjectStub<SessionPresence>);
    expect(ran).toBe(true);
    expect(closedEarly).toBe(false);

    const seconds = await readUsageSeconds(owner.id);
    expect(seconds).toBeGreaterThanOrEqual(595);
    expect(seconds).toBeLessThanOrEqual(610);
    expect(await getScheduledAlarm(stub)).not.toBeNull();

    socket.close(1000, "cleanup");
  });

  it("never decreases usage_months.seconds across an idle flush (clamps at clockStart)", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-idle-clamp-owner",
      email: "idle-clamp-owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Clamped", objective: null }, env.DB);
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName(created.session.id));
    const socket = await connectMetered(stub, owner.id, owner.id, created.session.id);
    const closed = nextClose(socket);

    // First periodic flush: activity is still recent (from connect), so this
    // takes the active branch and advances clockStart to "now".
    await setClockStart(stub, Date.now() - 20 * 60_000);
    const ran1 = await runDurableObjectAlarm(stub as unknown as DurableObjectStub<SessionPresence>);
    expect(ran1).toBe(true);
    const afterFirstFlush = await readUsageSeconds(owner.id);
    expect(afterFirstFlush).toBeGreaterThanOrEqual(1195);
    expect(afterFirstFlush).toBeLessThanOrEqual(1210);
    const clockStartAfterFirstFlush = await getClockStart(stub);
    expect(clockStartAfterFirstFlush).toBeDefined();

    // Now staleness catches up: lastActivityAt predates the clockStart the
    // first flush just advanced to. Without flushUsage's lower clamp,
    // (lastActivityAt - clockStart) is negative and would *decrease*
    // usage_months.seconds through `seconds = seconds + excluded.seconds`.
    await backdateAllLastActivity(stub, clockStartAfterFirstFlush! - 35 * 60_000);
    const ran2 = await runDurableObjectAlarm(stub as unknown as DurableObjectStub<SessionPresence>);
    expect(ran2).toBe(true);

    const event = await closed;
    expect(event.code).toBe(4004);

    const afterSecondFlush = await readUsageSeconds(owner.id);
    expect(afterSecondFlush).toBe(afterFirstFlush); // unchanged, never decreased
  });

  it("books elapsed time once for a session regardless of how many sockets are connected", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-double-owner",
      email: "double-owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const member = await upsertUser({
      providerUserId: "chatgpt-double-member",
      email: "double-member@example.com",
      displayName: "Member",
      fullName: "Member",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Double", objective: null }, env.DB);
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName(created.session.id));
    // Both connections meter to the same owner/session — matches production,
    // where the meter headers come from the session owner, not the
    // connecting member.
    const socketA = await connectMetered(stub, owner.id, owner.id, created.session.id);
    const socketB = await connectMetered(stub, member.id, owner.id, created.session.id);

    await setClockStart(stub, Date.now() - 5 * 60_000);

    // Client-initiated closes aren't awaited here — unlike the
    // server-initiated 4003/4004 closes elsewhere in this file, nothing in
    // this harness guarantees a client-close's own "close" event fires
    // promptly, so the DO's occupancy state is the thing to poll instead.
    socketA.close(1000, "tab A closed");
    await vi.waitFor(async () => {
      const openCount = await runInDurableObject(stub as unknown as DurableObjectStub<SessionPresence>, (_instance, state) =>
        (state.getWebSockets() as MeteredSocket[]).filter((socket) => socket.readyState === WebSocket.OPEN).length);
      expect(openCount).toBe(1); // socketB only — socketA has closed server-side
    });
    // socketB is still open — occupancy has not hit zero, so no flush yet.
    expect(await readUsageSeconds(owner.id)).toBe(0);

    socketB.close(1000, "tab B closed");
    await vi.waitFor(async () => {
      const seconds = await readUsageSeconds(owner.id);
      expect(seconds).toBeGreaterThan(0);
    });

    const seconds = await readUsageSeconds(owner.id);
    expect(seconds).toBeGreaterThanOrEqual(295);
    expect(seconds).toBeLessThanOrEqual(310);
  });

  it("clockStart survives eviction, so billing is not lost or reset around a DO restart", async () => {
    const owner = await upsertUser({
      providerUserId: "chatgpt-evict-meter-owner",
      email: "evict-meter-owner@example.com",
      displayName: "Owner",
      fullName: "Owner",
    }, env.DB);
    const created = await createSession(owner.id, { title: "Evicted", objective: null }, env.DB);
    const stub = env.SESSION_PRESENCE.get(env.SESSION_PRESENCE.idFromName(created.session.id));
    await connectMetered(stub, owner.id, owner.id, created.session.id);

    const tenMinutesAgo = Date.now() - 10 * 60_000;
    await setClockStart(stub, tenMinutesAgo);

    await evictDurableObject(stub);

    const preservedClockStart = await getClockStart(stub);
    expect(preservedClockStart).toBe(tenMinutesAgo);

    const ran = await runDurableObjectAlarm(stub as unknown as DurableObjectStub<SessionPresence>);
    expect(ran).toBe(true);
    const seconds = await readUsageSeconds(owner.id);
    expect(seconds).toBeGreaterThanOrEqual(595);
    expect(seconds).toBeLessThanOrEqual(610);
  });
});
