"use client";

import { FormEvent, useState } from "react";
import { BASE_PATH } from "@/components/basePath";
import { Spinner, useDialogDismiss } from "@/components/session/primitives";
import type { SessionSkillSummary } from "@/db/skills";
import { MAX_SKILL_CONTENT_CHARS } from "@/lib/skill-validation";

// Session-scoped imported Claude skills: members see the list, only the
// owner adds or removes. Rendered only while CLAUDE_RUN_ENABLED is on — the
// same hide-while-gated convention as Run and Verify runner.
export function SkillsCard({ sessionId, role, initialSkills }: {
  sessionId: string;
  role: "owner" | "member";
  initialSkills: SessionSkillSummary[];
}) {
  const [skills, setSkills] = useState(initialSkills);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function remove(skillId: string) {
    if (busyId) return;
    setBusyId(skillId);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/skills/${skillId}`, { method: "DELETE" });
    const body = (await response.json().catch(() => null)) as { skills?: SessionSkillSummary[]; error?: string } | null;
    if (!response.ok || !body?.skills) {
      setError(body?.error ?? "Unable to remove that skill. Try again.");
    } else {
      setSkills(body.skills);
    }
    setBusyId(null);
  }

  return (
    <section className="action-card" aria-label="Claude skills">
      <p className="eyebrow">Claude skills</p>
      <h2>Imported skills</h2>
      <p>Skills this session&rsquo;s Claude agents can invoke. Imported by the owner; shared by every agent on the floor.</p>
      {role === "owner" && (
        <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={() => setAdding(true)}>Add skill</button>
      )}
      {skills.length === 0 ? (
        <p>No skills imported. Claude runs use only their built-in tools.</p>
      ) : (
        <ul className="settings-category-list">
          {skills.map((skill) => (
            <li key={skill.id} className="settings-category-row">
              <span className="settings-category-name">{skill.name}</span>
              <span className="settings-category-detail">{skill.description}</span>
              {role === "owner" && (
                <button type="button" className="button" data-variant="quiet" data-size="sm" onClick={() => remove(skill.id)} disabled={busyId !== null}>
                  {busyId === skill.id ? "Removing…" : "Remove"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {adding && (
        <AddSkillDialog
          sessionId={sessionId}
          onClose={() => setAdding(false)}
          onAdded={(next) => {
            setSkills(next);
            setAdding(false);
          }}
        />
      )}
    </section>
  );
}

function AddSkillDialog({ sessionId, onClose, onAdded }: {
  sessionId: string;
  onClose: () => void;
  onAdded: (skills: SessionSkillSummary[]) => void;
}) {
  const { dismiss, dialogProps } = useDialogDismiss(onClose);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ready = content.trim().length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    setError(null);
    const response = await fetch(`${BASE_PATH}/api/sessions/${sessionId}/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const body = (await response.json().catch(() => null)) as { skills?: SessionSkillSummary[]; error?: string } | null;
    if (!response.ok || !body?.skills) {
      setError(body?.error ?? "Unable to import that skill. Try again.");
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    onAdded(body.skills);
  }

  return (
    <dialog className="dialog" {...dialogProps} aria-labelledby="add-skill-title">
      <form onSubmit={submit}>
        <div className="dialog-head">
          <div className="dialog-title">
            <h2 id="add-skill-title">Import a skill</h2>
            <p>Paste a SKILL.md: frontmatter with a lowercase slug <code>name</code> and a <code>description</code>, then the instructions. Re-importing a name replaces it.</p>
          </div>
        </div>
        <div className="dialog-body">
          <label className="field">
            <span className="label">SKILL.md contents</span>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={12}
              maxLength={MAX_SKILL_CONTENT_CHARS}
              spellCheck={false}
              placeholder={"---\nname: release-checklist\ndescription: Use when preparing a release.\n---\n\nInstructions…"}
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="button" data-variant="quiet" onClick={dismiss} disabled={submitting}>Cancel</button>
          <button type="submit" className="button" data-variant="primary" disabled={!ready || submitting}>{submitting ? <><Spinner />Importing…</> : "Import skill"}</button>
        </div>
      </form>
    </dialog>
  );
}
