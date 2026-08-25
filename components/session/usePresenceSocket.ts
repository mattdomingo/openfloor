"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import {
  INITIAL_PRESENCE_CONNECTION,
  isTerminal,
  reconnectDelayMs,
  reducePresenceConnection,
  type PresenceConnection,
  type PresenceConnectionAction,
} from "@/lib/presence-connection";
import type { PresenceEvent, TypingUpdate } from "@/lib/session-types";

export type PresenceSocketHandlers = {
  // Every parsed server event, including the presence.snapshot/changed
  // events this hook does not interpret itself.
  onEvent: (event: PresenceEvent) => void;
  // Fires once per (re)connect, the instant the first message proves the
  // socket is actually live — not on the browser's `open` event, which also
  // fires for a socket the server immediately rejects (see
  // lib/presence-connection.ts). The natural place to resend an in-flight
  // typing draft and catch up anything that changed while disconnected.
  // Takes `send` as a parameter (rather than callers closing over the hook's
  // own returned `send`) so there is no ordering dependency between defining
  // this callback and destructuring the hook's return value.
  onLive: (send: (update: TypingUpdate) => void) => void;
  // 4001 (membership ended) or 4005 (owner removed this member): terminal,
  // but a navigation rather than a connection state, so callers decide what
  // to do rather than the hook rendering anything for them.
  onLeave: (code: 4001 | 4005, reason: string) => void;
};

// Single presence-socket lifecycle shared by the lobby (SessionScreen) and
// the floor (AgentFloorScreen), which previously duplicated this and drifted
// on which close codes each one understood.
export function usePresenceSocket(sessionId: string, handlers: PresenceSocketHandlers) {
  const [connection, setConnection] = useState<PresenceConnection>(INITIAL_PRESENCE_CONNECTION);
  const socketRef = useRef<WebSocket | null>(null);
  // Handlers close over component state/refs that change every render;
  // reading them through a ref keeps the effect below mounted only once per
  // sessionId instead of on every handler identity change.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let disposed = false;
    // Mirrors `connection` synchronously inside this closure — the `state`
    // React holds only updates on the next render, but `connect`/`close`
    // handlers need the current status immediately (e.g. to skip scheduling
    // a reconnect once quota-exhausted is reached). Living in the effect
    // closure also means a quota-exhausted status cannot be lost by a
    // dependency-triggered effect re-run; only a real sessionId change does.
    let state = INITIAL_PRESENCE_CONNECTION;
    // Real presence, not merely an open socket: the DO's idle timeout (30
    // min) trims billing to this, so an unattended-but-visible tab must not
    // look active. Deliberately window-level and un-throttled — cost is a
    // timestamp write per event, no re-render.
    let lastInputAt = Date.now();

    function dispatch(action: PresenceConnectionAction) {
      state = reducePresenceConnection(state, action);
      setConnection(state);
    }

    function sendUpdate(update: TypingUpdate) {
      if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(update));
    }

    function noteInput() {
      lastInputAt = Date.now();
      if (disposed || state.status !== "idle" || document.visibilityState !== "visible") return;
      dispatch({ type: "input" });
      connect();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") noteInput();
    }

    function connect() {
      if (disposed || isTerminal(state.status)) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}${BASE_PATH}/api/sessions/${sessionId}/presence`);
      socketRef.current = socket;
      socket.addEventListener("message", (message) => {
        let event: PresenceEvent;
        try {
          event = JSON.parse(String(message.data)) as PresenceEvent;
        } catch {
          return;
        }
        const wasLive = state.status === "live";
        dispatch({ type: "message" });
        if (!wasLive) handlersRef.current.onLive(sendUpdate);
        handlersRef.current.onEvent(event);
      });
      socket.addEventListener("close", (event) => {
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        if (event.code === 4001 || event.code === 4005) {
          handlersRef.current.onLeave(event.code, event.reason);
          return;
        }
        dispatch({ type: "close", code: event.code, reason: event.reason });
        // Quota-exhausted never reconnects; an idle close waits for real
        // user input (noteInput, above) instead of a timer.
        if (event.code === 4003 || event.code === 4004) return;
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          dispatch({ type: "connect" });
          connect();
        }, reconnectDelayMs(state.attempts));
      });
    }

    const inputEvents = ["pointermove", "keydown", "focus", "scroll"] as const;
    for (const eventName of inputEvents) window.addEventListener(eventName, noteInput, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Heartbeat: only while the tab is visible and there has been real user
    // input recently, so an unattended tab (backgrounded or merely left
    // open) stops refreshing lastActivityAt server-side and the DO's idle
    // timeout can actually trim its billing.
    heartbeatTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastInputAt > 5 * 60_000) return;
      if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send("ping");
    }, 30_000);

    connect();
    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      if (heartbeatTimer) window.clearInterval(heartbeatTimer);
      for (const eventName of inputEvents) window.removeEventListener(eventName, noteInput);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      socket?.close(1000, "Presence socket closed");
    };
  }, [sessionId]);

  const send = useCallback((update: TypingUpdate) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(update));
  }, []);

  return { connection, send };
}
