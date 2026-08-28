"use client";

import { useEffect, useRef, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import { Spinner, useDialogDismiss } from "@/components/session/primitives";
import { repoCountLabel } from "@/lib/display-name";
import type { UserGitHubInstallationSummary } from "@/lib/session-types";

type Phase =
  | { name: "starting" }
  | { name: "waiting"; userCode: string; verificationUri: string }
  | { name: "installed"; installations: UserGitHubInstallationSummary[] }
  | { name: "authorized-no-install" }
  | { name: "expired" }
  | { name: "error"; message: string };

// GitHub connection as a device flow: show a short code, open
// github.com/login/device in the browser, poll until GitHub confirms, link
// the member's installations. When the server has no device-flow client id
// (501) this falls back to the classic App-install redirect automatically.
export function GitHubDeviceDialog({ purpose, returnTo, onConnected, onIdentity, onClose }: {
  purpose: "onboarding" | "settings";
  returnTo: string;
  onConnected: (installations: UserGitHubInstallationSummary[]) => void;
  onIdentity?: (user: { login: string; name: string | null }) => void;
  onClose: () => void;
}) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const [phase, setPhase] = useState<Phase>({ name: "starting" });
  const [installBusy, setInstallBusy] = useState(false);
  const stopped = useRef(false);

  // The classic redirect: used when device flow is unavailable, and offered
  // after an authorization that found no installations to grant repos with.
  async function openInstallPage() {
    setInstallBusy(true);
    const response = await fetch(`${BASE_PATH}/api/account/github/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose, returnTo }),
    });
    const body = await response.json().catch(() => null) as { installUrl?: string; error?: string } | null;
    if (!response.ok || !body?.installUrl) {
      setPhase({ name: "error", message: body?.error ?? "Unable to begin GitHub setup." });
      setInstallBusy(false);
      return;
    }
    window.location.assign(body.installUrl);
  }

  useEffect(() => {
    stopped.current = false;
    let timer: number | undefined;
    void (async () => {
      const started = await fetch(`${BASE_PATH}/api/account/github/device`, { method: "POST" });
      if (stopped.current) return;
      const start = await started.json().catch(() => null) as
        { deviceCode?: string; userCode?: string; verificationUri?: string; interval?: number; error?: string } | null;
      if (!started.ok || !start?.deviceCode || !start.userCode) {
        // Unconfigured (501), device flow not enabled on the App, or GitHub
        // unreachable — the classic install redirect covers every case.
        void openInstallPage();
        return;
      }
      const verificationUri = start.verificationUri ?? "https://github.com/login/device";
      // No auto-open: the person reads the code first, then follows the
      // button — a tab appearing before the code is visible just confuses.
      setPhase({ name: "waiting", userCode: start.userCode, verificationUri });

      let interval = Math.max(1, start.interval ?? 5);
      const poll = async () => {
        if (stopped.current) return;
        const response = await fetch(`${BASE_PATH}/api/account/github/device`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceCode: start.deviceCode }),
        });
        const body = await response.json().catch(() => null) as
          { pending?: boolean; interval?: number; expired?: boolean; connected?: boolean; installed?: boolean; installations?: UserGitHubInstallationSummary[]; githubUser?: { login?: string; name?: string | null } | null; error?: string } | null;
        if (stopped.current) return;
        if (body?.pending) {
          if (body.interval) interval = body.interval;
          timer = window.setTimeout(() => void poll(), interval * 1000);
          return;
        }
        if (body?.expired) {
          setPhase({ name: "expired" });
          return;
        }
        if (!response.ok || !body?.connected) {
          setPhase({ name: "error", message: body?.error ?? "GitHub declined the authorization." });
          return;
        }
        if (body.githubUser?.login) onIdentity?.({ login: body.githubUser.login, name: body.githubUser.name ?? null });
        const installations = body.installations ?? [];
        if (body.installed === false || installations.length === 0) {
          setPhase({ name: "authorized-no-install" });
          return;
        }
        setPhase({ name: "installed", installations });
        onConnected(installations);
      };
      timer = window.setTimeout(() => void poll(), interval * 1000);
    })();
    return () => {
      stopped.current = true;
      if (timer) window.clearTimeout(timer);
    };
    // Runs once per dialog open; the flow owns its own lifecycle after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <dialog className="dialog device-dialog" {...dialogProps} aria-labelledby="github-device-title">
      <div className="dialog-head">
        <div className="dialog-title">
          <h2 id="github-device-title">Connect GitHub</h2>
          <p>openfloor links the repositories your GitHub App installations can reach. Your GitHub token never lives here — it is used once to list them, then discarded.</p>
        </div>
      </div>
      <div className="dialog-body device-dialog-body">
        {phase.name === "starting" && <p className="device-dialog-status"><Spinner /> Contacting GitHub…</p>}
        {phase.name === "waiting" && (
          <>
            <p className="device-dialog-code" aria-label="Device code">{phase.userCode}</p>
            <p className="device-dialog-hint">
              Copy this code, then enter it on GitHub to connect.
            </p>
            <a className="button" data-variant="primary" href={phase.verificationUri} target="_blank" rel="noopener noreferrer">
              Open github.com/login/device
            </a>
            <p className="device-dialog-status"><Spinner /> Waiting for GitHub…</p>
          </>
        )}
        {phase.name === "installed" && (
          <>
            <p>Connected. openfloor can reach:</p>
            <ul className="device-dialog-installations">
              {phase.installations.filter((installation) => installation.status === "active").map((installation) => (
                <li key={installation.id}>
                  <strong>{installation.accountLogin}</strong>{" "}
                  <span>{[installation.accountType, repoCountLabel(installation.repoCount)].filter(Boolean).join(" · ")}</span>
                </li>
              ))}
            </ul>
            <p className="device-dialog-hint">
              Missing an account? Install openfloor on it — your own account included — then connect again.
            </p>
            <button type="button" className="button" data-variant="quiet" disabled={installBusy} onClick={() => void openInstallPage()}>
              {installBusy ? <><Spinner />Opening…</> : "Install on another GitHub account"}
            </button>
          </>
        )}
        {phase.name === "authorized-no-install" && (
          <>
            <p>GitHub authorized openfloor, but the app isn&rsquo;t installed on any of your repositories yet.</p>
            <button type="button" className="button" data-variant="primary" disabled={installBusy} onClick={() => void openInstallPage()}>
              {installBusy ? <><Spinner />Opening…</> : "Install openfloor on GitHub"}
            </button>
          </>
        )}
        {phase.name === "expired" && <p className="form-error" role="alert">The code expired before GitHub confirmed. Close this and try again.</p>}
        {phase.name === "error" && <p className="form-error" role="alert">{phase.message}</p>}
      </div>
      <div className="dialog-foot">
        {phase.name === "installed"
          ? <button type="button" className="button" data-variant="primary" onClick={dismiss}>Done</button>
          : <button type="button" className="button" data-variant="quiet" onClick={dismiss}>Cancel</button>}
      </div>
    </dialog>
  );
}
