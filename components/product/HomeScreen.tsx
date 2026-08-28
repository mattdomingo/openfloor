"use client";

import Link from "next/link";
import { CSSProperties, DragEvent as ReactDragEvent, FormEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/components/basePath";
import { LocalDateTime } from "@/components/LocalDateTime";
import { formatDuration } from "@/lib/date-format";
import { HoverTip, Icon, Spinner, useDialogDismiss, useHoverTip } from "@/components/session/primitives";
import { SelectMenu } from "@/components/session/SelectMenu";
import { lowHoursRemaining, planLabel, type Plan, type PlanStatus } from "@/lib/plans";
import { mergeVisibleOrder, parseSessionOrder, sortByStoredOrder } from "@/lib/session-order";
import { branchSlug } from "@/lib/repository-refs";
import { monthlyUsageLabel, type CredentialProvider, type MonthlyProviderUsage, type ProviderCredentialSummary } from "@/lib/provider-credentials";
import { formatTokens } from "@/components/session/data";
import type { AccountGitHubRepositoryOption, AppUser, SessionSummary } from "@/lib/session-types";
import { WaveField } from "@/app/entry-wave";
import { GuidedTour, type TourStep } from "@/components/GuidedTour";
import { AppHeader } from "./AppHeader";
import { ProviderCredentials } from "./ProviderCredentials";

// How far a tile is willing to lean toward the cursor, in pixels.
const CARD_MAGNET_REACH = 7;

/* Tile order is a per-device preference — nobody else sees your arrangement,
   so it stays local UI state (AGENTS.md's third state class, alongside panel
   order on the floor) rather than becoming a D1 column. Stored as one id
   list covering every tab, so a card keeps its place when it is archived and
   comes back. Same useSyncExternalStore shape as ThemeToggle, which keeps
   the server render (no stored order) and hydration in step. */
const ORDER_STORAGE_KEY = "openfloor:session-order";
const ORDER_CHANGE_EVENT = "openfloor:session-order-change";

function subscribeToOrder(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(ORDER_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(ORDER_CHANGE_EVENT, callback);
  };
}

// The raw string is the snapshot, not a parsed array: useSyncExternalStore
// compares snapshots by identity, and a fresh array every call would loop.
function readStoredOrder(): string {
  return localStorage.getItem(ORDER_STORAGE_KEY) ?? "";
}

function writeOrder(ids: string[]) {
  localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(ids));
  window.dispatchEvent(new Event(ORDER_CHANGE_EVENT));
}


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
  initialCredentials,
  enabledProviders,
  modelUsage,
}: {
  user: AppUser;
  sessions: SessionSummary[];
  usage: Usage;
  initialCredentials: ProviderCredentialSummary[];
  enabledProviders: CredentialProvider[];
  modelUsage: MonthlyProviderUsage[];
}) {
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
  const [repositories, setRepositories] = useState<AccountGitHubRepositoryOption[]>([]);
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
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
  const storedOrder = useSyncExternalStore(subscribeToOrder, readStoredOrder, () => "");
  const orderedSessions = useMemo(() => sortByStoredOrder(sessions, parseSessionOrder(storedOrder)), [sessions, storedOrder]);

  async function beginCreate() {
    setCreating(true);
    setRepositoriesLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`${BASE_PATH}/api/account/github/repositories`, { cache: "no-store" });
      const body = await response.json() as { repositories?: AccountGitHubRepositoryOption[]; error?: string };
      if (!response.ok || !body.repositories) throw new Error(body.error ?? "Unable to load GitHub repositories.");
      setRepositories(body.repositories);
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "Unable to load GitHub repositories.");
    } finally {
      setRepositoriesLoading(false);
    }
  }
  const activeSessions = orderedSessions.filter((session) => session.archivedAt == null && session.endedAt == null);
  const archivedSessions = orderedSessions.filter((session) => session.archivedAt != null);
  const endedSessions = orderedSessions.filter((session) => session.archivedAt == null && session.endedAt != null);
  const tabSessions = tab === "archived" ? archivedSessions : tab === "ended" ? endedSessions : activeSessions;
  // Hours are metered per session and summed onto one monthly total, so two
  // live owned sessions burn the month at twice wall-clock — worth calling
  // out explicitly, or it reads as a billing bug rather than the chosen
  // (and documented) behavior.
  const liveOwnedSessions = sessions.filter((session) => session.role === "owner" && session.endedAt == null).length;
  const quotaExhausted = Number.isFinite(usage.limitHours) && usage.seconds >= usage.limitHours * 3600;
  const lowHours = lowHoursRemaining(usage.seconds, usage.limitHours);
  // A deleted-and-resignedup email on the free plan gets a real 0h limit
  // (lib/plans.ts's planHourLimit), not "nothing purchased yet" — distinct
  // from the ordinary used-up-this-month case, so it gets its own copy
  // instead of a usage bar with nothing to divide by.
  const freeAllowanceUsedUp = usage.effectivePlan === "free" && usage.limitHours === 0;
  const usageLimitSeconds = usage.limitHours * 3600;
  const usagePercent = !Number.isFinite(usage.limitHours) ? null : freeAllowanceUsedUp ? 100 : Math.min(100, Math.round((usage.seconds / usageLimitSeconds) * 100));
  // What the Usage tab shows is the inverse of usagePercent — remaining
  // capacity, not consumed capacity, so "0%" reads as "none left".
  const usageRemainingPercent = usagePercent != null ? Math.max(0, 100 - usagePercent) : null;
  // Each line below is its own single template-string expression (not
  // several adjacent JSX text nodes) — React SSR inserts an <!-- -->
  // hydration-boundary comment between adjacent text nodes, which would
  // otherwise split a phrase like "Free plan" across a comment.
  const usagePlanLine = `${planLabel(usage.effectivePlan)} plan`;
  const usageStatLine = freeAllowanceUsedUp
    ? "This account's free session hours were already used."
    : Number.isFinite(usage.limitHours)
    ? `${formatDuration(usage.seconds)} of ${usage.limitHours}h session time used this month (UTC)`
    : `${formatDuration(usage.seconds)} session time used this month (UTC)`;
  const usageLiveLine = `${liveOwnedSessions} live sessions, all counting toward your usage`;

  function applyVisibleOrder(nextVisible: string[]) {
    writeOrder(mergeVisibleOrder(orderedSessions.map((session) => session.id), nextVisible));
  }

  async function setArchived(session: SessionSummary, archived: boolean) {
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}/${archived ? "archive" : "unarchive"}`, { method: "POST" });
    if (!response.ok) return;
    setSessions((current) =>
      current.map((entry) => (entry.id === session.id ? { ...entry, archivedAt: archived ? Date.now() : null } : entry)),
    );
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
                {freeAllowanceUsedUp
                  ? "This account already used its free openfloor hours. "
                  : `Your ${planLabel(usage.effectivePlan)} plan's ${usage.limitHours}h of monthly session time is used up. `}
                {/* No `from` here on purpose: tests/render/rendered-html.test.ts:224
                    asserts this literal href, and the settings origin resolver
                    (app/home/settings/origin.ts) already falls back to Sessions/home
                    when `from` is absent — appending it would be redundant. */}
                <Link href="/home/settings?section=plan">{freeAllowanceUsedUp ? "Choose a plan to continue" : "Upgrade for more session hours"}</Link>.
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
          <CreateSessionDialog
            repositories={repositories}
            repositoriesLoading={repositoriesLoading}
            loadError={loadError}
            initialCredentials={initialCredentials}
            enabledProviders={enabledProviders}
            onClose={() => setCreating(false)}
          />
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
                {usagePercent != null && !freeAllowanceUsedUp && (
                  <progress className="usage-meter" value={Math.min(usage.seconds, usageLimitSeconds)} max={usageLimitSeconds} aria-label={`${usagePercent}% of monthly session time used`} />
                )}
                <p className="usage-card-stat">{usageStatLine}</p>
                {liveOwnedSessions > 1 && <p className="usage-card-note">{usageLiveLine}</p>}
              </div>
              <div className="usage-card">
                <p className="usage-card-plan">Model usage this month (UTC)</p>
                {modelUsage.length === 0 ? (
                  <p className="usage-card-stat">No model usage this month.</p>
                ) : (
                  <ul className="usage-model-list">
                    {modelUsage.map((row) => (
                      <li key={`${row.provider}-${row.kind}`}>
                        <span>{monthlyUsageLabel(row)}</span>
                        <span>{`$${(row.microUsd / 1_000_000).toFixed(2)} · ${formatTokens(row.inputTokens)} in / ${formatTokens(row.outputTokens)} out`}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : tab === "active" ? (
            <SessionGrid sessions={activeSessions} archived={false} showCreateTile onCreateNew={() => void beginCreate()} onDelete={setPendingDelete} onSetArchived={setArchived} limitSeats={usage.limitSeats} onReorder={applyVisibleOrder} />
          ) : tabSessions.length === 0 ? (
            <div className="empty-state">
              <strong>Nothing here</strong>
              <p>{tab === "archived" ? "Archive a session from Active or Ended to tuck it out of your own view." : "Sessions the owner ends will show up here."}</p>
            </div>
          ) : (
            <SessionGrid sessions={tabSessions} archived={tab === "archived"} onDelete={setPendingDelete} onSetArchived={setArchived} limitSeats={usage.limitSeats} onReorder={applyVisibleOrder} />
          )}
        </div>
      </section>
      {pendingDelete && <DeleteSessionDialog session={pendingDelete} onClose={() => setPendingDelete(null)} />}
      {/* Keyed per account so a recreated account sees the tour again; the
          dismissal itself stays device-local like the theme. */}
      <GuidedTour storageKey={`openfloor:tutorial:home:${user.id}`} steps={HOME_TOUR} />
    </main>
  );
}

// First-visit walkthrough (ENG-17). The floor carries its own tour, so this
// one teaches only /home: the tabs and the New session tile, then it follows
// the tile's click straight into the create dialog and walks every field in
// form order, ending on the real Create session click — that final click
// both ends the tour and creates the session, landing on the agent floor
// where FLOOR_TOUR picks up. The five field steps are gated (isSatisfied):
// each waits for the field to actually be filled — a task typed, an
// objective typed, a repository selected, a candidate branch name present,
// a provider actually connected — rather than advancing on a bare click,
// and Enter is the step's own "continue" once it is.
const HOME_TOUR: TourStep[] = [
  {
    selector: ".shop-tabs",
    title: "Your sessions",
    body: "Filter Active, Archived, and Ended sessions, and check monthly usage. Drag a card by its grip to reorder the grid.",
  },
  {
    selector: '[aria-label="New session"]',
    title: "Start a session",
    body: "A session is one room for one goal. Click + to name the task, pick the GitHub repository, and optionally connect an AI provider — all on one page.",
  },
  {
    selector: '.create-dialog [data-tour="task"]',
    title: "Name the task",
    body: "This names the session and seeds the candidate branch name below.",
    isSatisfied: () => Boolean((document.querySelector('.create-dialog [data-tour="task"]') as HTMLInputElement | null)?.value.trim()),
  },
  {
    selector: '.create-dialog [data-tour="goal"]',
    title: "Say what done looks like",
    body: "This is the shared objective the floor works toward — the team can update it later.",
    isSatisfied: () => Boolean((document.querySelector('.create-dialog [data-tour="goal"]') as HTMLTextAreaElement | null)?.value.trim()),
  },
  {
    selector: '.create-dialog [aria-label="Session repository"]',
    title: "Pick the repository",
    body: "The GitHub repository agents clone and push to. No repositories listed? Add GitHub access in Account Settings.",
    isSatisfied: () => Boolean(document.querySelector('.create-dialog [aria-label="Session repository"] span')?.textContent?.trim()),
  },
  {
    selector: '.create-dialog [data-tour="candidate-name"]',
    title: "Name the candidate branch",
    body: "Runs land on this candidate branch, never on the repository's default branch, until the team reviews and merges.",
    isSatisfied: () => Boolean((document.querySelector('.create-dialog [data-tour="candidate-name"]') as HTMLInputElement | null)?.value.trim()),
  },
  {
    selector: '.create-dialog section[aria-label="AI connection"]',
    title: "Check your AI is connected",
    body: "Agents refuse to run with no connected provider. Expand the one you want and connect it.",
    isSatisfied: () => Boolean(document.querySelector('.create-dialog section[aria-label="AI connection"] [data-connected="true"]')),
  },
  {
    selector: '.create-dialog button[type="submit"]',
    title: "Create the session",
    body: "Click Create session. You land on the agent floor — it walks you through itself the first time.",
  },
];

function SessionGrid({
  sessions,
  archived,
  onDelete,
  onSetArchived,
  limitSeats,
  showCreateTile,
  onCreateNew,
  onReorder,
}: {
  sessions: SessionSummary[];
  archived: boolean;
  onDelete: (session: SessionSummary) => void;
  onSetArchived: (session: SessionSummary, archived: boolean) => void;
  limitSeats: number;
  showCreateTile?: boolean;
  onCreateNew?: () => void;
  onReorder: (nextVisible: string[]) => void;
}) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // While a drag is live the grid renders this order instead of the saved
  // one, so the other cards visibly step aside as the cursor moves. Nothing
  // is persisted until drop; an abandoned drag animates back.
  const [previewIds, setPreviewIds] = useState<string[] | null>(null);
  const visible = useMemo(() => {
    if (!previewIds) return sessions;
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const shown = previewIds.flatMap((id) => byId.get(id) ?? []);
    // A session that appeared mid-drag (realtime refresh) still renders.
    for (const session of sessions) if (!previewIds.includes(session.id)) shown.push(session);
    return shown;
  }, [previewIds, sessions]);
  const ids = visible.map((session) => session.id);

  // The dragged card takes the hovered card's slot and everything between
  // shifts one place — the classic list-move, previewed live on dragover.
  function previewOver(targetId: string) {
    if (!draggedId || draggedId === targetId) return;
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    animateReorder(() => setPreviewIds(next));
  }

  // The keyboard path, driven from the same grip: one step per press.
  function nudge(id: string, delta: number) {
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    animateReorder(() => onReorder(next));
  }

  return (
    <div className="session-grid">
      {showCreateTile && onCreateNew && <NewSessionTile onClick={onCreateNew} />}
      {visible.map((session, index) => (
        <SessionCard
          key={session.id}
          session={session}
          archived={archived}
          onDelete={onDelete}
          onSetArchived={onSetArchived}
          limitSeats={limitSeats}
          position={index + 1}
          total={visible.length}
          dragging={draggedId === session.id}
          dropTarget={dragOverId === session.id}
          onDragStart={() => setDraggedId(session.id)}
          onDragEnd={() => {
            // Fires after drop (preview already committed and cleared) and
            // on an abandoned drag, where the preview animates back.
            setDraggedId(null);
            setDragOverId(null);
            animateReorder(() => setPreviewIds(null));
          }}
          onDragOver={(event) => {
            if (!draggedId) return;
            // Only a preventDefault'd dragover marks this a valid drop target.
            event.preventDefault();
            if (draggedId !== session.id) setDragOverId(session.id);
            previewOver(session.id);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setDragOverId((current) => (current === session.id ? null : current));
          }}
          onDrop={() => {
            setDragOverId(null);
            if (draggedId && previewIds) onReorder(previewIds);
            setDraggedId(null);
            setPreviewIds(null);
          }}
          onNudge={(delta) => nudge(session.id, delta)}
        />
      ))}
    </div>
  );
}

/* Reorders animate as a view transition — each card carries a
   view-transition-name, so the browser FLIPs it from its old grid slot to
   the new one. Browsers without the API, and anyone preferring reduced
   motion, get today's instant reflow. flushSync is what the API needs: the
   DOM must reach its new state inside the callback, not on React's
   schedule. */
function animateReorder(update: () => void) {
  const doc = document as Document & {
    startViewTransition?: (callback: () => void) => { ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void> };
  };
  if (!doc.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  const transition = doc.startViewTransition(() => { flushSync(update); });
  // Rapid dragover steps start a new transition before the last one ends;
  // the browser skips the old one and REJECTS its promises ("Skipped
  // ViewTransition due to another transition starting"). That skip is the
  // behavior we want — swallow the rejections so they don't surface as
  // unhandled. The state update itself always applies either way.
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
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
  position,
  total,
  dragging,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onNudge,
}: {
  session: SessionSummary;
  archived: boolean;
  onDelete: (session: SessionSummary) => void;
  onSetArchived: (session: SessionSummary, archived: boolean) => void;
  limitSeats: number;
  position: number;
  total: number;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDrop: () => void;
  onNudge: (delta: number) => void;
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
  // draggable has to be true before the gesture starts, so the grip arms it on
  // pointer down and the card disarms it again once the drag is over. Arming
  // the whole card unconditionally would make every text selection a drag.
  const [armed, setArmed] = useState(false);
  const seatsOrMembers =
    session.role === "owner" && Number.isFinite(limitSeats)
      ? `${session.memberCount} of ${limitSeats} seats`
      : `${session.memberCount} ${session.memberCount === 1 ? "member" : "members"}`;
  return (
    <div
      ref={cardRef}
      className="session-card"
      // Names the card for animateReorder's view transition. Session ids are
      // uuids; stripping anything else keeps the name a valid CSS ident.
      style={{ viewTransitionName: `session-card-${session.id.replace(/[^a-zA-Z0-9_-]/g, "")}` } as CSSProperties}
      data-actions-open={actionsOpen ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      data-drop-target={dropTarget ? "true" : undefined}
      draggable={armed}
      onDragStart={onDragStart}
      onDragEnd={() => { setArmed(false); onDragEnd(); }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onMouseMove={(event) => { if (!actionsOpen) handleCardPointerMove(event); }}
      onMouseLeave={handleCardPointerLeave}
    >
      <div className="session-card-head">
        {/* The anchor is still the title, but its ::after (shop.css) stretches
            over the whole card, so anywhere that isn't the grip or the actions
            menu opens the session. The objective's hover tip therefore hangs
            off the link rather than the paragraph it describes — the paragraph
            sits under that overlay and would never see a pointer event. */}
        <Link className="session-card-link" href={`/session/${session.id}`} draggable={false} {...(descriptionTruncated ? tip.handlers : {})}><strong>{session.title}</strong></Link>
        <span className="session-card-tools">
          <button
            type="button"
            className="session-card-grip"
            aria-label={`Reorder ${session.title}. Position ${position} of ${total}. Drag, or use the left and right arrow keys.`}
            onPointerDown={() => setArmed(true)}
            onPointerUp={() => setArmed(false)}
            onPointerCancel={() => setArmed(false)}
            onKeyDown={(event) => {
              const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
              if (delta === 0) return;
              event.preventDefault();
              onNudge(delta);
            }}
          >
            <Icon name="grip" />
          </button>
          <SessionActionsMenu session={session} archived={archived} onDelete={onDelete} onSetArchived={onSetArchived} onOpenChange={handleActionsOpenChange} />
        </span>
      </div>
      <p className="session-card-updated">Updated <LocalDateTime timestamp={session.updatedAt} mode="date" /></p>
      {session.objective ? (
        <>
          <p className="session-card-desc" ref={descriptionRef}>{session.objective}</p>
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

// The create flow is a centered modal: task, goal, repository, candidate
// branch, and an optional AI connection, all on one page — then straight
// to the agent floor. A failed candidate provision lands on the lobby with the
// repository gate open instead, same as the webapp's old inline card did.
// One <form> spans the whole dialog (display: contents, so it adds no box of
// its own and .dialog's flex-column layout of head/body/foot is unaffected)
// so Enter in a text field submits.
function CreateSessionDialog({ repositories, repositoriesLoading, loadError, initialCredentials, enabledProviders, onClose }: {
  repositories: AccountGitHubRepositoryOption[];
  repositoriesLoading: boolean;
  loadError: string | null;
  initialCredentials: ProviderCredentialSummary[];
  enabledProviders: CredentialProvider[];
  onClose: () => void;
}) {
  const router = useRouter();
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  // Repositories arrive after the dialog opens; adopt the first as default.
  if (!repositoryId && repositories.length > 0) setRepositoryId(repositories[0].id);
  // The candidate name mirrors the task title until the owner deliberately
  // edits it — most sessions never need a second name, but touching it once
  // stops further title edits from silently overwriting it.
  const [candidateName, setCandidateName] = useState("");
  const [candidateNameTouched, setCandidateNameTouched] = useState(false);
  const effectiveCandidateName = candidateNameTouched ? candidateName : title;
  const [credentials, setCredentials] = useState(initialCredentials);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const canCreate = trimmedTitle.length > 0 && Boolean(repositoryId) && effectiveCandidateName.trim().length > 0;

  async function createSession() {
    const selectedRepository = repositories.find((repository) => repository.id === repositoryId);
    if (!selectedRepository) {
      setError("Select a GitHub repository.");
      return;
    }
    setError(null);
    setSubmitting(true);
    const response = await fetch(`${BASE_PATH}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: trimmedTitle,
        objective,
        repositoryId: selectedRepository.id,
        accountInstallationId: selectedRepository.accountInstallationId,
        candidateName: effectiveCandidateName,
      }),
    });
    const body = (await response.json()) as { session?: SessionSummary; setupStatus?: "ready" | "failed"; error?: string };
    if (!response.ok || !body.session) {
      setError(body.error ?? "Unable to create the session.");
      setSubmitting(false);
      return;
    }
    router.push(body.setupStatus === "failed"
      ? `/session/${body.session.id}?repo=required`
      : `/session/${body.session.id}/floor`);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (canCreate && !submitting) void createSession();
  }

  return (
    <dialog className="dialog create-dialog" {...dialogProps} aria-labelledby="create-session-title">
      <form onSubmit={handleSubmit} style={{ display: "contents" }}>
        <div className="dialog-head setup-dialog-head">
          <div className="dialog-title">
            <p className="eyebrow">New session</p>
            <h2 id="create-session-title">Name the session</h2>
            <p>Name the task, pick the repository, and optionally connect an AI provider.</p>
          </div>
        </div>
        <div className="dialog-body create-dialog-body">
          <label><span>Task</span><input data-tour="task" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} required autoFocus placeholder="What is this session for?" /></label>
          <label><span>Goal <em>optional</em></span><textarea data-tour="goal" value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={2000} rows={3} placeholder="The shared objective the floor works toward" /></label>
          <label>
            <span>Repository</span>
            {repositories.length > 0 ? (
              <SelectMenu
                label="Session repository"
                value={repositoryId}
                onChange={setRepositoryId}
                disabled={repositoriesLoading}
                options={repositories.map((repository) => ({ value: repository.id, label: repository.fullName }))}
              />
            ) : repositoriesLoading ? <small>Loading GitHub repositories…</small> : (
              <small>No repositories available. <Link href="/home/settings?section=connections">Add GitHub access in Account Settings</Link>.</small>
            )}
          </label>
          {loadError && <p className="form-error" role="alert">{loadError}</p>}
          <label>
            <span>Candidate branch name</span>
            <input
              data-tour="candidate-name"
              value={effectiveCandidateName}
              onChange={(event) => {
                setCandidateNameTouched(true);
                setCandidateName(event.target.value);
              }}
              maxLength={100}
              placeholder={trimmedTitle || "Candidate name"}
            />
          </label>
          {/* The record and branch don't exist until the server creates
              them, so only the slug segment (a pure function of the
              name) is real here — the session/candidate ids render as
              literal placeholders rather than invented hex. */}
          <p className="form-note">
            Branch that will be created: <code>openfloor/&lt;session&gt;/candidate/{branchSlug(effectiveCandidateName || trimmedTitle)}-&lt;id&gt;</code>
          </p>
          <section className="setup-credentials" aria-label="AI connection">
            <p>
              Optional: at least one connected provider is required to run agents — you can also add one later in
              Settings. A run uses the key connected by that agent&rsquo;s owner, then the configured server key. If
              neither is available, the run refuses clearly. Stored values are encrypted and never returned to the
              browser.
            </p>
            <ProviderCredentials initialCredentials={credentials} providers={enabledProviders} showAgentDefaults onCredentialsChange={setCredentials} />
          </section>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-foot setup-dialog-foot">
          <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={submitting}>Cancel</button>
          <button type="submit" className="button" data-variant="primary" disabled={submitting || !canCreate}>{submitting ? <><Spinner />Creating…</> : "Create session"}</button>
        </div>
      </form>
    </dialog>
  );
}

function DeleteSessionDialog({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
  const router = useRouter();
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [blockingRunId, setBlockingRunId] = useState<string | null>(null);
  const [candidateLive, setCandidateLive] = useState<{ branch: string; canDeleteBranch: boolean } | null>(null);
  const [branchDeleteFailed, setBranchDeleteFailed] = useState<{ branch: string } | null>(null);

  async function remove(candidate?: "delete-branch" | "orphan") {
    setBusy(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${session.id}`, {
      method: "DELETE",
      headers: candidate ? { "content-type": "application/json" } : undefined,
      body: candidate ? JSON.stringify({ candidate }) : undefined,
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string; code?: string; runId?: string; branch?: string; canDeleteBranch?: boolean } | null;
      if (body?.code === "candidate_live" && body.branch) {
        setCandidateLive({ branch: body.branch, canDeleteBranch: Boolean(body.canDeleteBranch) });
        setBusy(false);
        return;
      }
      if (body?.code === "branch_delete_failed" && body.branch) {
        setBranchDeleteFailed({ branch: body.branch });
        setBusy(false);
        return;
      }
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
      {candidateLive && !warning && (
        <div className="dialog-body"><p>The candidate branch <strong>{candidateLive.branch}</strong> hasn&rsquo;t merged yet. Decide what happens to it before the session is deleted.</p></div>
      )}
      {branchDeleteFailed && !warning && (
        <div className="dialog-body"><p className="form-error" role="alert">Couldn&rsquo;t delete <strong>{branchDeleteFailed.branch}</strong> on GitHub. The session hasn&rsquo;t been deleted yet — try again, or leave the branch and delete the session anyway.</p></div>
      )}
      <div className="dialog-foot">
        {warning ? (
          <button type="button" className="button" onClick={dismiss}>Close</button>
        ) : branchDeleteFailed ? (
          <>
            <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
            <button type="button" className="button" onClick={() => void remove("orphan")} disabled={busy}>Leave branch, delete session</button>
            <button type="button" className="button danger-button" onClick={() => void remove("delete-branch")} disabled={busy}>Try again</button>
          </>
        ) : candidateLive ? (
          <>
            <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
            <button type="button" className="button" onClick={() => void remove("orphan")} disabled={busy}>Leave branch, delete session</button>
            {candidateLive.canDeleteBranch && (
              <button type="button" className="button danger-button" onClick={() => void remove("delete-branch")} disabled={busy}>Delete branch &amp; session</button>
            )}
          </>
        ) : (
          <>
            <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={busy}>Cancel</button>
            {blockingRunId ? (
              <button type="button" className="button danger-button" onClick={cancelAndRetry} disabled={busy}>Cancel that run &amp; delete session</button>
            ) : (
              <button type="button" className="button danger-button" onClick={() => void remove()} disabled={busy}>Delete session</button>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}
