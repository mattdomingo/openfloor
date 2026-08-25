import { describe, expect, it } from "vitest";
import {
  INITIAL_PRESENCE_CONNECTION,
  isTerminal,
  reconnectDelayMs,
  reducePresenceConnection,
  type PresenceConnection,
} from "@/lib/presence-connection";

describe("reducePresenceConnection", () => {
  it("stays connecting through an open event with no message (the 4003 accept-then-close case)", () => {
    // No `open` action exists in this machine on purpose — the browser fires
    // `open` for a socket the server immediately rejects, so `connect` alone
    // must not read as live.
    const state = reducePresenceConnection(INITIAL_PRESENCE_CONNECTION, { type: "connect" });
    expect(state.status).toBe("connecting");
  });

  it("only a message proves the socket is live, and resets attempts", () => {
    const backedOff: PresenceConnection = { status: "reconnecting", attempts: 3, reason: null };
    const state = reducePresenceConnection(backedOff, { type: "message" });
    expect(state).toEqual({ status: "live", attempts: 0, reason: null });
  });

  it("close code 4003 is terminal and survives further connect/input actions", () => {
    let state = reducePresenceConnection(INITIAL_PRESENCE_CONNECTION, {
      type: "close",
      code: 4003,
      reason: "Quota exhausted",
    });
    expect(state.status).toBe("quota-exhausted");
    expect(isTerminal(state.status)).toBe(true);

    state = reducePresenceConnection(state, { type: "connect" });
    expect(state.status).toBe("quota-exhausted");
    state = reducePresenceConnection(state, { type: "input" });
    expect(state.status).toBe("quota-exhausted");
    state = reducePresenceConnection(state, { type: "close", code: 1006, reason: "" });
    expect(state.status).toBe("quota-exhausted");
  });

  it("close code 4004 goes idle and only reconnects on input, not on its own", () => {
    let state = reducePresenceConnection({ status: "live", attempts: 0, reason: null }, {
      type: "close",
      code: 4004,
      reason: "Disconnected for inactivity",
    });
    expect(state.status).toBe("idle");

    state = reducePresenceConnection(state, { type: "connect" });
    expect(state.status).toBe("idle");

    state = reducePresenceConnection(state, { type: "input" });
    expect(state.status).toBe("connecting");
  });

  it("backs off with growing attempts on repeated non-terminal closes", () => {
    let state = INITIAL_PRESENCE_CONNECTION;
    for (let i = 1; i <= 3; i++) {
      state = reducePresenceConnection(state, { type: "close", code: 1006, reason: "" });
      expect(state.status).toBe("reconnecting");
      expect(state.attempts).toBe(i);
    }
  });

  it("reconnectDelayMs doubles with a floor and a 10s cap", () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(1)).toBe(500);
    expect(reconnectDelayMs(2)).toBe(1_000);
    expect(reconnectDelayMs(3)).toBe(2_000);
    expect(reconnectDelayMs(10)).toBe(10_000);
  });
});
