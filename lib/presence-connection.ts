// Pure state machine for the presence WebSocket's client-visible connection
// state. Deliberately does not treat the browser's `open` event as evidence
// of a live connection: the server's quota gate (worker/presence.ts) accepts
// the upgrade and immediately closes with 4003 — a 4xx upgrade failure is
// opaque to the WebSocket API, so accept-then-close is the only way to hand
// the browser a close code. That means `open` fires for a socket that was
// never really live. `presence.snapshot` is the first thing a real
// connection sends (worker/presence.ts's acceptConnection), so "a message
// arrived" is used as the live signal instead.

export type PresenceStatus = "connecting" | "live" | "reconnecting" | "idle" | "quota-exhausted";

export type PresenceConnection = {
  status: PresenceStatus;
  attempts: number;
  reason: string | null;
};

export type PresenceConnectionAction =
  | { type: "connect" }
  | { type: "message" }
  | { type: "close"; code: number; reason: string }
  | { type: "input" };

export const INITIAL_PRESENCE_CONNECTION: PresenceConnection = { status: "connecting", attempts: 0, reason: null };

// Quota exhaustion is terminal for the rest of the billing period: once
// reached, no `connect`/`input` action may move the machine out of it.
export function isTerminal(status: PresenceStatus): boolean {
  return status === "quota-exhausted";
}

export function reconnectDelayMs(attempts: number): number {
  return Math.min(10_000, 500 * 2 ** Math.min(Math.max(attempts - 1, 0), 5));
}

export function reducePresenceConnection(state: PresenceConnection, action: PresenceConnectionAction): PresenceConnection {
  if (isTerminal(state.status)) return state;

  switch (action.type) {
    case "connect":
      // Only fired when the backoff timer elapses and the hook actually
      // opens a new socket. Idle status waits for real user input (the
      // `input` action below) before this transition is allowed — a bare
      // `connect` must not bypass that wait.
      return state.status === "reconnecting" ? { ...state, status: "connecting" } : state;
    case "message":
      return { status: "live", attempts: 0, reason: null };
    case "close":
      if (action.code === 4003) return { status: "quota-exhausted", attempts: state.attempts, reason: action.reason };
      if (action.code === 4004) return { status: "idle", attempts: 0, reason: action.reason };
      return { status: "reconnecting", attempts: state.attempts + 1, reason: action.reason };
    case "input":
      // Only an idle close waits for input before retrying; a reconnecting
      // or already-connecting socket is already on its own timer/attempt.
      return state.status === "idle" ? { ...state, status: "connecting" } : state;
    default:
      return state;
  }
}
