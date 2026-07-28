"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SegmentedControl } from "@/components/session/primitives";
import { getMockUser, nameFromEmail, setMockUser } from "./mockAuth";

type Tab = "login" | "register" | "join";

export function LandingScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("login");

  useEffect(() => {
    if (getMockUser()) router.replace("/home");
  }, [router]);

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);

  const [joinName, setJoinName] = useState("");
  const [sessionCode, setSessionCode] = useState("");
  const [sessionPassword, setSessionPassword] = useState("");

  function submitLogin(event: FormEvent) {
    event.preventDefault();
    if (!loginEmail.trim() || !loginPassword.trim()) return;
    setMockUser({ name: nameFromEmail(loginEmail), email: loginEmail.trim() });
    router.push("/home");
  }

  function submitRegister(event: FormEvent) {
    event.preventDefault();
    setRegisterError(null);

    if (!name.trim() || !email.trim() || !password) {
      setRegisterError("Fill in your name, email, and a password.");
      return;
    }
    if (password !== confirmPassword) {
      setRegisterError("Passwords don't match.");
      return;
    }

    setMockUser({ name: name.trim(), email: email.trim() });
    router.push("/home");
  }

  function submitJoin(event: FormEvent) {
    event.preventDefault();
    const code = sessionCode.trim();
    if (!code || !sessionPassword.trim()) return;

    setMockUser({ name: joinName.trim() || "Guest", email: "guest@openfloor.local" });
    router.push(`/session/${encodeURIComponent(code)}`);
  }

  return (
    <main className="landing">
      <div className="landing-hero">
        {/* eslint-disable-next-line @next/next/no-img-element -- static mark, no next/image config in this Vite host */}
        <img className="landing-logo" src="/app/openfloor-lockup.png" alt="OpenFloor" />
        <p>
          A shared control plane for teams coordinating coding agents against one software objective — dispatch work,
          resolve overlaps, and review integrated changes together.
        </p>
      </div>

      <div className="landing-card">
        <SegmentedControl
          label="Landing action"
          value={tab}
          onChange={setTab}
          options={[
            { value: "login", label: "Log in" },
            { value: "register", label: "Register" },
            { value: "join", label: "Join a session" },
          ]}
        />

        {tab === "login" && (
          <form className="landing-form" onSubmit={submitLogin}>
            <label className="field">
              <span className="label">Email</span>
              <input
                type="email"
                value={loginEmail}
                onChange={(event) => setLoginEmail(event.target.value)}
                required
                autoComplete="email"
              />
            </label>
            <label className="field">
              <span className="label">Password</span>
              <input
                type="password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                required
                autoComplete="current-password"
              />
            </label>
            <button type="submit" className="button" data-variant="primary" data-block="true">
              Log in
            </button>
          </form>
        )}

        {tab === "register" && (
          <form className="landing-form" onSubmit={submitRegister}>
            <label className="field">
              <span className="label">Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} required autoComplete="name" />
            </label>
            <label className="field">
              <span className="label">Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="email"
              />
            </label>
            <div className="field-grid">
              <label className="field">
                <span className="label">Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="new-password"
                />
              </label>
              <label className="field">
                <span className="label">Confirm password</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  autoComplete="new-password"
                />
              </label>
            </div>
            {registerError && <p className="landing-error">{registerError}</p>}
            <button type="submit" className="button" data-variant="primary" data-block="true">
              Create account
            </button>
          </form>
        )}

        {tab === "join" && (
          <form className="landing-form" onSubmit={submitJoin}>
            <p className="landing-hint">Paste a session code and password from a teammate to jump straight in.</p>
            <label className="field">
              <span className="label">Your name</span>
              <input value={joinName} onChange={(event) => setJoinName(event.target.value)} placeholder="Guest" autoComplete="name" />
            </label>
            <label className="field">
              <span className="label">Session code</span>
              <input
                className="field-mono"
                value={sessionCode}
                onChange={(event) => setSessionCode(event.target.value)}
                required
                placeholder="e.g. realtime-presence"
              />
            </label>
            <label className="field">
              <span className="label">Session password</span>
              <input
                className="field-mono"
                type="password"
                value={sessionPassword}
                onChange={(event) => setSessionPassword(event.target.value)}
                required
              />
            </label>
            <button type="submit" className="button" data-variant="primary" data-block="true">
              Join session
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
