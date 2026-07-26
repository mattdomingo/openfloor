"use client";

import { Assignment, latestDecision } from "./data";
import { Avatar } from "./primitives";
import { Panel, PanelChrome } from "./Rail";

export function BriefRail({
  chrome,
  assignments,
  onAssignmentChange,
  onNotice,
}: {
  chrome: PanelChrome;
  assignments: Assignment[];
  onAssignmentChange: (id: string, task: string) => void;
  onNotice: (notice: string) => void;
}) {
  return (
    <Panel chrome={chrome} title="Team" meta={`${assignments.length} people`} badge={`${assignments.length}`}>
      <div className="rail-section">
        <div className="rail-section-head">
          <span className="label">Ownership</span>
          <span className="value">Editable by everyone</span>
        </div>
        <div className="owner-list">
          {assignments.map((assignment) => (
            <div className="owner-card" key={assignment.id}>
              <Avatar initials={assignment.initials} tone={assignment.tone} />
              <div className="owner-head">
                <strong>{assignment.name}</strong>
                <span className="value">{assignment.agent}</span>
                <span className="state-tag" data-tone={assignment.stateTone}>
                  {assignment.state}
                </span>
              </div>
              <textarea
                value={assignment.task}
                aria-label={`Assignment for ${assignment.name}`}
                onChange={(event) => onAssignmentChange(assignment.id, event.target.value)}
                onBlur={() => onNotice(`${assignment.name}'s assignment updated for everyone`)}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="rail-section">
        <div className="rail-section-head">
          <span className="label">Latest decision</span>
        </div>
        <div className="decision">
          <strong>{latestDecision.statement}</strong>
          <span>{latestDecision.attribution}</span>
        </div>
      </div>
    </Panel>
  );
}
