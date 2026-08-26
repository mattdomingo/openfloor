"use client";

import Link from "next/link";
import { FormEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { LocalDateTime } from "@/components/LocalDateTime";
import { formatDuration } from "@/lib/date-format";
import { HoverTip, useDialogDismiss, useHoverTip } from "@/components/session/primitives";
import { lowHoursRemaining, planLabel, type Plan, type PlanStatus } from "@/lib/plans";
import type { AppUser, SessionSummary } from "@/lib/session-types";
import { WaveField } from "@/app/entry-wave";
import { AppHeader } from "./AppHeader";

// How far a tile is willing to lean toward the cursor, in pixels.
const CARD_MAGNET_REACH = 7;

function handleCardPointerMove(event: ReactMouseEvent<HTMLElement>) {
  const card = event.currentTarget;
  const rect = card.getBoundingClientRect();
  const px = (event.clientX - rect.left) / rect.width;
  const py = (event.clientY - rect.top) / rect.height;
  card.style.setProperty("--tilt-x", `${(px - 0.5) * 2 * CARD_MAGNET_REACH}px`);
  card.style.setProperty("--tilt-y", `${(py - 0.5) * 2 * CARD_MAGNET_REACH}px`);
}

function handleCardPointerLeave(event: ReactMouseEvent<HTMLElement>) {
  const card = event.currentTarget;
  card.style.setProperty("--tilt-x", "0px");
  card.style.setProperty("--tilt-y", "0px");
}

// True once the (line-clamped) element is actually cut off — the hover tip
// that reveals the rest should only ever appear when there's more to read.
function useIsTruncated<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [truncated, setTruncated] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setTruncated(el.scrollHeight > el.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, truncated };
}

type SessionTab = "active" | "archived" | "ended" | "usage";
type ShopTabOption = { value: SessionTab; label: string; tone?: "usage" };

// A tab strip whose selected option is marked only by its text color — the
// pair of floor brackets (the same mask-image glyph as the bracket buttons)
// is a hover mark instead: it slides/snaps to whichever tab the pointer (or
// focus) is currently over and fades out smoothly once nothing is hovered.
// Position/width are measured off the real DOM (labels vary in length —
// "Active (2)" vs "Usage (0%)" — so this can't be done in pure CSS) and
// written as an inline transform, which keeps it off React's render path
// and lets it animate smoothly. The indicator's last position/width is kept
// after hover ends (only its opacity drops) so the fade-out has somewhere
// to fade from instead of jumping.
function ShopTabs({ value, onChange, options }: { value: SessionTab; onChange: (value: SessionTab) => void; options: ShopTabOption[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<{ x: number; width: number } | null>(null);
  const [hovered, setHovered] = useState<SessionTab | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const button = hovered ? buttonRefs.current.get(hovered) : null;
    if (!container || !button) return;
    const measure = () => {
      const containerBox = container.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      setIndicator({ x: buttonBox.left - containerBox.left - 8, width: buttonBox.width + 16 });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [hovered, options.length]);

  const hoveredTone = options.find((option) => option.value === hovered)?.tone;

  return (
    <div className="shop-tabs" ref={containerRef} role="group" aria-label="Filter sessions" onMouseLeave={() => setHovered(null)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          ref={(element) => {
            if (element) buttonRefs.current.set(option.value, element);
            else buttonRefs.current.delete(option.value);
          }}
          className="shop-tab"
          data-tone={option.tone}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          onMouseEnter={() => setHovered(option.value)}
          onFocus={() => setHovered(option.value)}
          onBlur={() => setHovered((current) => (current === option.value ? null : current))}
        >
          {option.label}
        </button>
      ))}
      {indicator && (
        <span
          className="shop-tab-indicator"
          data-tone={hoveredTone}
          data-visible={hovered ? "true" : "false"}
          aria-hidden="true"
          style={{ transform: `translate(${indicator.x}px, -50%)`, width: indicator.width }}
        />
      )}
    </div>
  );
}
type Usage = { plan: Plan; planStatus: PlanStatus; effectivePlan: Plan; seconds: number; limitHours: number; limitSeats: number };

export function HomeScreen({
  user,
  sessions: initialSessions,
  usage,
}: {
  user: AppUser;
  sessions: SessionSummary[];
  usage: Usage;
}) {
  const router = useRouter();
  const [sessions, setSessions] = useState(initialSessions);
  // router.refresh() (after delete) re-renders this Server Component prop without
  // remounting HomeScreen, so local state needs to resync — done during render,
  // React's documented pattern, rather than in an effect (avoids an extra render).
  const [syncedSessions, setSyncedSessions] = useState(initialSessions);
  if (syncedSessions !== initialSessions) {
    setSyncedSessions(initialSessions);
    setSessions(initialSessions);
  }
  const [tab, setTab] = useState<SessionTab>("active");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  // The removal close code (4005) fires while the removed member is still on
  // the session or floor page, which navigates here before this component
  // mounts — sessionStorage is the only way to carry the reason across that
  // navigation. A lazy initializer (not an effect) reads and clears it
  // exactly once so a later reload never resurfaces a stale notice.
  const [removedNotice, setRemovedNotice] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = sessionStorage.getItem("openfloor:removed-notice");
    if (stored) sessionStorage.removeItem("openfloor:removed-notice");
    return stored;
  });
  const activeSessions = sessions.filter((session) => session.archivedAt == null && session.endedAt == null);
  const archivedSessions = sessions.filter((session) => session.archivedAt != null);
  const endedSessions = sessions.filter((session) => session.archivedAt == null && session.endedAt != null);
  const tabSessions = tab === "archived" ? archivedSessions : tab === "ended" ? endedSessions : activeSessions;
  // Hours are metered per session and summed onto one monthly total, so two
  // live owned sessions burn the month at twice wall-clock — worth calling
  // out explicitly, or it reads as a billing bug rather than the chosen
  // (and documented) behavior.
  const liveOwnedSessions = sessions.filter((session) => session.role === "owner" && session.endedAt == null).length;
  const quotaExhausted = Number.isFinite(usage.limitHours) && usage.seconds >= usage.limitHours * 3600;
  const lowHours = lowHoursRemaining(usage.seconds, usage.limitHours);
  const usageLimitSeconds = usage.limitHours * 3600;
  const usagePercent = Number.isFinite(usage.limitHours) ? Math.min(100, Math.round((usage.seconds / usageLimitSeconds) * 100)) : null;
  // What the Usage tab shows is the inverse of usagePercent — remaining
  // capacity, not consumed capacity, so "0%" reads as "none left".
  const usageRemainingPercent = usagePercent != null ? Math.max(0, 100 - usagePercent) : null;
  // Each line below is its own single template-string expression (not
  // several adjacent JSX text nodes) — React SSR inserts an <!-- -->
  // hydration-boundary comment between adjacent text nodes, which would
  // otherwise split a phrase like "Free plan" across a comment.
  const usagePlanLine = `${planLabel(usage.effectivePlan)} plan`;
  const usageStatLine = Number.isFinite(usage.limitHours)
    ? `${formatDuration(usage.seconds)} of ${usage.limitHours}h session time used this month (UTC)`
    : `${formatDuration(usage.seconds)} session time used this month (UTC)`;
  const usageLiveLine = `${liveOwnedSessions} live sessions, all counting toward your usage`;

  async function setArchived(session: SessionSummary, archived: boolean) {
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}/${archived ? "archive" : "unarchive"}`, { method: "POST" });
    if (!response.ok) return;
    setSessions((current) =>
      current.map((entry) => (entry.id === session.id ? { ...entry, archivedAt: archived ? Date.now() : null } : entry)),
    );
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const response = await fetch(`${BASE_PATH}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, objective }),
    });
    const body = (await response.json()) as { session?: SessionSummary; error?: string };
    if (!response.ok || !body.session) {
      setError(body.error ?? "Unable to create the session.");
      setSubmitting(false);
      return;
    }
    router.push(`/session/${body.session.id}?setup=1`);
  }

  return (
    <main className="product-shell shop-shell">
      <WaveField varName="--wave" className="shop-wave" />
      <AppHeader user={user} />
      <section className="page-body">
        <div className="page-heading">
          <div className="page-heading-title">
            <h1>{user.displayName.split(" ")[0]}’s sessions</h1>
            {removedNotice && (
              <p className="notice" data-tone="attention" role="status">
                {removedNotice} <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={() => setRemovedNotice(null)}>Dismiss</button>
              </p>
            )}
            {quotaExhausted && (
              /* Advisory only, same as the ended-session banner in
                 Workspace.tsx: the 403s on create/dispatch are the
                 enforcement. */
              <p className="notice" data-tone="attention" role="status">
                {`Your ${planLabel(usage.effectivePlan)} plan's ${usage.limitHours}h of monthly session time is used up. `}
                {/* No `from` here on purpose: tests/render/rendered-html.test.ts:224
                    asserts this literal href, and the settings origin resolver
                    (app/home/settings/origin.ts) already falls back to Sessions/home
                    when `from` is absent — appending it would be redundant. */}
                <Link href="/home/settings?section=plan">Upgrade for more session hours</Link>.
              </p>
            )}
            {lowHours != null && (
              /* The same advisory tone one step earlier: nothing is blocked
                 yet, but the ceiling is close enough to plan around. */
              <p className="notice" data-tone="attention" role="status">
                {`${formatDuration(lowHours)} of your ${planLabel(usage.effectivePlan)} plan's ${usage.limitHours}h of monthly session time is left. `}
                <Link href="/home/settings?section=plan">Upgrade for more session hours</Link>.
              </p>
            )}
          </div>
        </div>

        {creating && (
          <form className="create-card" onSubmit={create}>
            <label><span>Session title</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} required autoFocus /></label>
            <label><span>Objective <em>optional</em></span><textarea value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={2000} rows={3} /></label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="form-actions">
              <button type="button" className="button" data-variant="quiet" onClick={() => setCreating(false)}>Cancel</button>
              <button className="button" data-variant="primary" disabled={submitting}>{submitting ? "Creating…" : "Create session"}</button>
            </div>
          </form>
        )}

        {/* Usage is a fourth tab, not a side toggle, so it (and the tab
            strip itself) renders regardless of session count — a brand-new
            user still has a plan to see. */}
        <ShopTabs
          value={tab}
          onChange={setTab}
          options={[
            { value: "active", label: `Active (${activeSessions.length})` },
            { value: "archived", label: `Archived (${archivedSessions.length})` },
            { value: "ended", label: `Ended (${endedSessions.length})` },
            { value: "usage", label: usageRemainingPercent != null ? `Usage (${usageRemainingPercent}%)` : "Usage", tone: "usage" },
          ]}
        />
        {/* key={tab} remounts this on every tab switch so the CSS enter
            animation (.tab-panel, shop.css) replays each time. */}
        <div className="tab-panel" key={tab}>
          {tab === "usage" ? (
            <div className="usage-tab-content">
              <div className="usage-card">
                <p className="usage-card-plan">{usagePlanLine}</p>
                {usagePercent != null && (
                  <progress className="usage-meter" value={Math.min(usage.seconds, usageLimitSeconds)} max={usageLimitSeconds} aria-label={`${usagePercent}% of monthly session time used`} />
                )}
                <p className="usage-card-stat">{usageStatLine}</p>
                {liveOwnedSessions > 1 && <p className="usage-card-note">{usageLiveLine}</p>}
              </div>
            </div>
          ) : tab === "active" ? (
            <SessionGrid sessions={activeSessions} archived={false} showCreateTile onCreateNew={() => setCreating(true)} onDelete={setPendingDelete} onSetArchived={setArchived} limitSeats={usage.limitSeats} />
          ) : tabSessions.length === 0 ? (
            <div className="empty-state">
              <strong>Nothing here</strong>
              <p>{tab === "archived" ? "Archive a session from Active or Ended to tuck it out of your own view." : "Sessions the owner ends will show up here."}</p>
            </div>
          ) : (
            <SessionGrid sessions={tabSessions} archived={tab === "archived"} onDelete={setPendingDelete} onSetArchived={setArchived} limitSeats={usage.limitSeats} />
          )}
        </div>
      </section>
      {pendingDelete && <DeleteSessionDialog session={pendingDelete} onClose={() => setPendingDelete(null)} />}
    </main>
  );
}

function SessionGrid({
  sessions,
  archived,
  onDelete,
  onSetArchived,
  limitSeats,
  showCreateTile,
  onCreateNew,
}: {
  sessions: SessionSummary[];
  archived: boolean;
  onDelete: (session: SessionSummary) => void;
  onSetArchived: (session: SessionSummary, archived: boolean) => void;
  limitSeats: number;
  showCreateTile?: boolean;
  onCreateNew?: () => void;
}) {
  return (
    <div className="session-grid">
      {showCreateTile && onCreateNew && <NewSessionTile onClick={onCreateNew} />}
      {sessions.map((session) => (
        <SessionCard key={session.id} session={session} archived={archived} onDelete={onDelete} onSetArchived={onSetArchived} limitSeats={limitSeats} />
      ))}
    </div>
  );
}

// The tile that starts a new session — a plain "+" rather than a label, so
// the tooltip (the same HoverTip used for a clamped objective) is what
// actually says "New session". Shares the magnet-hover handlers with a
// real session tile so it reads as one of the grid, not a banner above it.
function NewSessionTile({ onClick }: { onClick: () => void }) {
  const tip = useHoverTip();
  return (
    <>
      <button
        type="button"
        className="session-card session-card-new"
        onClick={onClick}
        onMouseEnter={tip.handlers.onMouseEnter}
        onMouseMove={(event) => {
          handleCardPointerMove(event);
          tip.handlers.onMouseMove(event);
        }}
        onMouseLeave={(event) => {
          handleCardPointerLeave(event);
          tip.handlers.onMouseLeave();
        }}
        aria-label="New session"
      >
        <span className="session-card-new-plus" aria-hidden="true">+</span>
      </button>
      <HoverTip position={tip.position}>New session</HoverTip>
    </>
  );
}

function SessionCard({
  session,
  archived,
  onDelete,
  onSetArchived,
  limitSeats,
}: {
  session: SessionSummary;
  archived: boolean;
  onDelete: (session: SessionSummary) => void;
  onSetArchived: (session: SessionSummary, archived: boolean) => void;
  limitSeats: number;
}) {
  // Title, then when it last changed (a quiet caption, not competing with
  // the meta strip below), then the objective — clamped, the full text is
  // a hover away only when it's actually cut off — then the foot strip,
  // now down to just the two facts that matter together: who and how much.
  const tip = useHoverTip();
  const cardRef = useRef<HTMLDivElement>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const handleActionsOpenChange = useCallback((open: boolean) => {
    cardRef.current?.style.setProperty("--tilt-x", "0px");
    cardRef.current?.style.setProperty("--tilt-y", "0px");
    setActionsOpen(open);
  }, []);
  const { ref: descriptionRef, truncated: descriptionTruncated } = useIsTruncated<HTMLParagraphElement>();
  const seatsOrMembers =
    session.role === "owner" && Number.isFinite(limitSeats)
      ? `${session.memberCount} of ${limitSeats} seats`
      : `${session.memberCount} ${session.memberCount === 1 ? "member" : "members"}`;
  return (
    <div ref={cardRef} className="session-card" data-actions-open={actionsOpen ? "true" : undefined} onMouseMove={(event) => { if (!actionsOpen) handleCardPointerMove(event); }} onMouseLeave={handleCardPointerLeave}>
      <div className="session-card-head">
        {/* The link stays on the title text so tests and readers keep one obvious target. */}
        <Link className="session-card-link" href={`/session/${session.id}`}><strong>{session.title}</strong></Link>
        <SessionActionsMenu session={session} archived={archived} onDelete={onDelete} onSetArchived={onSetArchived} onOpenChange={handleActionsOpenChange} />
      </div>
      <p className="session-card-updated">Updated <LocalDateTime timestamp={session.updatedAt} mode="date" /></p>
      {session.objective ? (
        <>
          <p className="session-card-desc" ref={descriptionRef} {...(descriptionTruncated ? tip.handlers : {})}>{session.objective}</p>
          {descriptionTruncated && <HoverTip position={tip.position}>{session.objective}</HoverTip>}
        </>
      ) : (
        <p className="session-card-desc" data-empty="true">No objective has been written yet.</p>
      )}
      <div className="session-card-meta">
        <span className="session-card-role">
          {session.role}
          {session.endedAt != null && " · Ended"}
        </span>
        <span className="session-card-stats">{`${seatsOrMembers} · ${formatDuration(session.activeSeconds)} active`}</span>
      </div>
    </div>
  );
}

// Archive/Delete collapse behind a dot trigger and reveal inline — the same
// widening-gap idea as the pre-auth sign-in mark — rather than sitting
// permanently exposed on every tile. Dismisses on outside click or Escape,
// same interaction model as AccountMenu.
function SessionActionsMenu({
  session,
  archived,
  onDelete,
  onSetArchived,
  onOpenChange,
}: {
  session: SessionSummary;
  archived: boolean;
  onDelete: (session: SessionSummary) => void;
  onSetArchived: (session: SessionSummary, archived: boolean) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const setMenuOpen = useCallback((next: boolean) => {
    setOpen(next);
    onOpenChange(next);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, setMenuOpen]);

  return (
    <div className="session-card-menu" data-open={open ? "true" : "false"} ref={rootRef}>
      <button type="button" className="session-card-menu-trigger" aria-haspopup="true" aria-expanded={open} aria-label="Session actions" onClick={() => setMenuOpen(!open)}>
        <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
      </button>
      <span className="session-card-menu-actions" inert={!open}>
        <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={() => { onSetArchived(session, !archived); setMenuOpen(false); }}>{archived ? "Unarchive" : "Archive"}</button>
        {session.role === "owner" && <button type="button" className="button danger-button" data-size="sm" onClick={() => { onDelete(session); setMenuOpen(false); }}>Delete</button>}
      </span>
    </div>
  );
}

function DeleteSessionDialog({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
  const router = useRouter();
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [blockingRunId, setBlockingRunId] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}`, { method: "DELETE" });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string; runId?: string } | null;
      setError(body?.error ?? "Unable to delete the session");
      setBlockingRunId(body?.runId ?? null);
      setBusy(false);
      return;
    }
    const body = (await response.json().catch(() => null)) as { warning?: string } | null;
    if (body?.warning) {
      setWarning(body.warning);
      setBusy(false);
      router.refresh();
      return;
    }
    dismiss();
    router.refresh();
  }

  async function cancelAndRetry() {
    if (!blockingRunId) return;
    setBusy(true);
    setError(null);
    await fetch(`${BASE_PATH}/api/sessions/${session.id}/runs/${encodeURIComponent(blockingRunId)}/cancel`, { method: "POST" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}`, { method: "DELETE" });
      if (response.ok) {
        setBlockingRunId(null);
        const body = (await response.json().catch(() => null)) as { warning?: string } | null;
        if (body?.warning) {
          setWarning(body.warning);
          setBusy(false);
        } else {
          dismiss();
        }
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string; runId?: string } | null;
      if (!body?.runId) {
        setError(body?.error ?? "Unable to delete the session");
        setBlockingRunId(null);
        setBusy(false);
        return;
      }
    }
    setError("The run is taking longer than expected to cancel. Try again in a moment.");
    setBusy(false);
  }

  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="delete-session-title">
      <div className="dialog-head">
        <div className="dialog-title"><h2 id="delete-session-title">Delete “{session.title}”?</h2><p>This permanently removes the session for every member: floor, queue, messages, and repository connection. It cannot be undone.</p></div>
      </div>
      {error && <div className="dialog-body"><p className="form-error" role="alert">{error}</p></div>}
      {warning && <div className="dialog-body"><p role="status">Session deleted. {warning}</p></div>}
      <div className="dialog-foot">
        {warning ? (
          <button type="button" className="button" onClick={dismiss}>Close</button>
        ) : (
          <>
            <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
            {blockingRunId ? (
              <button type="button" className="button danger-button" onClick={cancelAndRetry} disabled={busy}>Cancel that run &amp; delete session</button>
            ) : (
              <button type="button" className="button danger-button" onClick={remove} disabled={busy}>Delete session</button>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}
