"use client";

import { CSSProperties, FormEvent, useEffect, useId, useRef, useState } from "react";
import {
  AgentAutonomy,
  AgentDraft,
  agentBranchName,
  agentColorOptions,
  agentModels,
  agentRolePresets,
  autonomyOptions,
  baseBranchOptions,
  checkOptions,
  participants,
} from "./data";
import { Icon } from "./primitives";

export function CreateAgentDialog({
  suggestedName,
  onCreate,
  onClose,
}: {
  suggestedName: string;
  onCreate: (draft: AgentDraft) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const modelHintId = useId();
  const scopeHintId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(suggestedName);
  const [roleId, setRoleId] = useState(agentRolePresets[0].id);
  const [task, setTask] = useState("");
  const [owner, setOwner] = useState("You");
  const [color, setColor] = useState(agentRolePresets[0].color);
  const [model, setModel] = useState(agentRolePresets[0].model);
  const [autonomy, setAutonomy] = useState<AgentAutonomy>("auto-edit");
  const [baseBranch, setBaseBranch] = useState(baseBranchOptions[0]);
  const [branch, setBranch] = useState<string | null>(null);
  const [scope, setScope] = useState(agentRolePresets[0].scope);
  const [checks, setChecks] = useState(["types", "unit", "lint"]);
  const [reviewRequired, setReviewRequired] = useState(true);

  // The branch follows the name and task until it is edited by hand.
  const branchValue = branch ?? agentBranchName(name, task);
  const modelHint = agentModels.find((option) => option.id === model)?.detail ?? "";
  const ready = name.trim().length > 0 && task.trim().length > 0;

  // Modal mode gives us the top layer, focus containment, and Escape for free.
  // It also claims focus, so the name field is selected afterwards.
  useEffect(() => {
    dialogRef.current?.showModal();
    nameRef.current?.select();
  }, []);

  function choosePreset(id: string) {
    const preset = agentRolePresets.find((option) => option.id === id) ?? agentRolePresets[0];
    setRoleId(id);
    setColor(preset.color);
    setModel(preset.model);
    setScope(preset.scope);
  }

  function toggleCheck(id: string) {
    setChecks((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;

    onCreate({
      name,
      roleId,
      task,
      owner,
      color,
      model,
      autonomy,
      baseBranch,
      branch: branchValue,
      scope,
      checks,
      reviewRequired,
    });
  }

  // Escape, Cancel, and the close button dismiss; a stray backdrop click must not
  // discard a filled-in form.
  return (
    <dialog className="dialog" ref={dialogRef} aria-labelledby={titleId} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="dialog-head">
          <div className="dialog-title">
            <h2 id={titleId}>New coding agent</h2>
            <p>It gets its own worktree, claims a write scope, and reports to the floor.</p>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        <div className="dialog-body">
          <div className="field-grid" data-cols="3">
            <label className="field">
              <span className="label">Name</span>
              <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} required maxLength={24} />
            </label>
            <label className="field">
              <span className="label">Role</span>
              <select value={roleId} onChange={(event) => choosePreset(event.target.value)}>
                {agentRolePresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span className="label">Colour</span>
              <div className="swatch-row" role="group" aria-label="Identity colour">
                {agentColorOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="swatch"
                    style={{ "--swatch": option.value } as CSSProperties}
                    aria-pressed={color === option.value}
                    onClick={() => setColor(option.value)}
                  >
                    <span className="sr-only">{option.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <label className="field">
            <span className="label">Task</span>
            <input
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="Add reconnect replay to the session socket"
              required
            />
          </label>

          <div className="field-grid">
            <label className="field">
              <span className="label">Model</span>
              <select value={model} onChange={(event) => setModel(event.target.value)} aria-describedby={modelHintId}>
                {agentModels.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="field-hint" id={modelHintId}>
                {modelHint}
              </span>
            </label>
            <label className="field">
              <span className="label">Launched by</span>
              <select value={owner} onChange={(event) => setOwner(event.target.value)}>
                <option value="You">You</option>
                {participants.map((person) => (
                  <option key={person.id} value={person.name}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="field">
            <legend className="label">Autonomy</legend>
            <div className="choice-list">
              {autonomyOptions.map((option) => (
                <label className="choice" key={option.value} data-selected={autonomy === option.value ? "true" : "false"}>
                  <input
                    type="radio"
                    name="autonomy"
                    value={option.value}
                    checked={autonomy === option.value}
                    onChange={() => setAutonomy(option.value)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    {option.detail}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="field-grid">
            <label className="field">
              <span className="label">Branch from</span>
              <select value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)}>
                {baseBranchOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="label">Worktree branch</span>
              <input className="field-mono" value={branchValue} onChange={(event) => setBranch(event.target.value)} />
            </label>
          </div>

          <label className="field">
            <span className="label">Write scope</span>
            <textarea
              className="field-mono"
              rows={3}
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              aria-describedby={scopeHintId}
            />
            <span className="field-hint" id={scopeHintId}>
              One path per line. Edits outside the scope need a new claim on the floor.
            </span>
          </label>

          <fieldset className="field">
            <legend className="label">Run before every patch</legend>
            <div className="check-grid">
              {checkOptions.map((option) => (
                <label className="check" key={option.id}>
                  <input type="checkbox" checked={checks.includes(option.id)} onChange={() => toggleCheck(option.id)} />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="check check-standalone">
            <input type="checkbox" checked={reviewRequired} onChange={(event) => setReviewRequired(event.target.checked)} />
            <span>Require a teammate review before integration</span>
          </label>
        </div>

        <div className="dialog-foot">
          <span className="value">
            <Icon name="branch" size={12} />
            {branchValue}
          </span>
          <button type="button" className="button" data-variant="quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" data-variant="primary" disabled={!ready}>
            Create agent
          </button>
        </div>
      </form>
    </dialog>
  );
}
