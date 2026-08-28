"use client";

import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { BASE_PATH } from "@/components/basePath";
import type { RunActivityEvent } from "@/lib/floor-types";

const MAX_EVENTS_PER_RUN = 200;
const EMPTY_EVENTS: RunActivityEvent[] = [];

export type RunActivitySource = {
  eventsFor(runId: string): RunActivityEvent[];
  subscribe(runId: string, listener: () => void): () => void;
  ingest(payload: { runId: string; events: RunActivityEvent[] }): void;
  catchUp(runIds: string[]): void;
  loadTimeline(runId: string): void;
};

function merge(current: RunActivityEvent[] | undefined, incoming: RunActivityEvent[]): RunActivityEvent[] {
  const bySequence = new Map<number, RunActivityEvent>();
  for (const event of current ?? []) bySequence.set(event.sequence, event);
  for (const event of incoming) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence).slice(-MAX_EVENTS_PER_RUN);
}

export function useRunActivity(sessionId: string): RunActivitySource {
  const eventsByRunRef = useRef(new Map<string, RunActivityEvent[]>());
  const listenersByRunRef = useRef(new Map<string, Set<() => void>>());
  const loadingRef = useRef(new Set<string>());

  const notify = useCallback((runId: string) => {
    const listeners = listenersByRunRef.current.get(runId);
    if (listeners) {
      for (const listener of listeners) {
        listener();
      }
    }
  }, []);

  const store = useCallback((runId: string, incoming: RunActivityEvent[]) => {
    if (incoming.length === 0) return;
    const current = eventsByRunRef.current.get(runId);
    const next = merge(current, incoming);
    eventsByRunRef.current.set(runId, next);
    notify(runId);
  }, [notify]);

  const fetchEvents = useCallback(async (runId: string, after: number) => {
    if (loadingRef.current.has(runId)) return;
    loadingRef.current.add(runId);
    try {
      const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/runs/${runId}/events?after=${after}`, { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { events: RunActivityEvent[] };
      store(runId, body.events);
    } catch {
      // Broadcasts and the next catch-up close any gap a failed fetch leaves.
    } finally {
      loadingRef.current.delete(runId);
    }
  }, [sessionId, store]);

  const ingest = useCallback((payload: { runId: string; events: RunActivityEvent[] }) => {
    store(payload.runId, payload.events);
  }, [store]);

  const catchUp = useCallback((runIds: string[]) => {
    for (const runId of runIds) {
      const known = eventsByRunRef.current.get(runId);
      void fetchEvents(runId, known?.length ? known[known.length - 1].sequence : 0);
    }
  }, [fetchEvents]);

  const loadTimeline = useCallback((runId: string) => {
    if (!eventsByRunRef.current.get(runId)?.length) void fetchEvents(runId, 0);
  }, [fetchEvents]);

  const eventsFor = useCallback((runId: string) => eventsByRunRef.current.get(runId) ?? EMPTY_EVENTS, []);

  const subscribe = useCallback((runId: string, listener: () => void) => {
    let set = listenersByRunRef.current.get(runId);
    if (!set) {
      set = new Set();
      listenersByRunRef.current.set(runId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        listenersByRunRef.current.delete(runId);
      }
    };
  }, []);

  return useMemo(() => ({ eventsFor, subscribe, ingest, catchUp, loadTimeline }), [eventsFor, subscribe, ingest, catchUp, loadTimeline]);
}

export function useRunEvents(activity: RunActivitySource, runId: string | null | undefined): RunActivityEvent[] {
  return useSyncExternalStore(
    useCallback((onStoreChange) => {
      if (!runId) return () => {};
      return activity.subscribe(runId, onStoreChange);
    }, [activity, runId]),
    () => (runId ? activity.eventsFor(runId) : EMPTY_EVENTS),
    () => EMPTY_EVENTS,
  );
}
