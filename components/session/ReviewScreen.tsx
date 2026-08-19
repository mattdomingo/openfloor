"use client";

import { useMemo, useState } from "react";
import type { FloorMessage, FloorParticipant, FloorReviewSnapshot } from "@/lib/floor-types";
import { Icon } from "./primitives";
import { TeamChat } from "./TeamChat";

export function ReviewScreen({ review, teamChat, onSendTeamMessage, participants, currentUserId }: {
  review: FloorReviewSnapshot | null;
  teamChat: FloorMessage[];
  onSendTeamMessage: (text: string, recipientUserId: string | null) => Promise<boolean>;
  participants: FloorParticipant[];
  currentUserId: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(review?.files[0]?.id ?? null);
  const selected = useMemo(() => review?.files.find((file) => file.id === selectedId) ?? review?.files[0] ?? null, [review, selectedId]);

  if (!review) {
    return <section className="review-screen" aria-label="Review"><div className="review-empty-state"><Icon name="branch" size={22} /><h2>No review available</h2><p>Files, checks, warnings, and approval controls will appear only after a connected agent backend creates a real review candidate.</p></div><section className="review-pane review-team-chat" aria-label="Team chat"><div className="review-pane-head"><h3>Team chat</h3><span>{teamChat.filter((message) => message.recipientUserId === null).length}</span></div><TeamChat messages={teamChat} onSend={onSendTeamMessage} participants={participants} currentUserId={currentUserId} /></section></section>;
  }

  const additions = review.files.reduce((total, file) => total + file.additions, 0);
  const deletions = review.files.reduce((total, file) => total + file.deletions, 0);
  return <section className="review-screen" aria-label="Review candidate">
    <header className="review-hero"><div className="review-hero-copy"><span className="label">Candidate branch</span><h2><Icon name="branch" size={16} />{review.branch}</h2><p>Review data supplied by the connected backend.</p></div><div className="review-hero-facts"><div><span className="label">Commit</span><strong className="value">{review.commitSha ?? "Not committed"}</strong></div><div><span className="label">Base</span><strong className="value">{review.baseBranch}</strong></div><div><span className="label">Diff</span><strong><span className="add">+{additions}</span> <span className="del">−{deletions}</span></strong></div><div><span className="label">Status</span><strong>{review.status}</strong></div></div></header>
    <div className="review-grid"><aside className="review-pane" aria-label="Changed files"><div className="review-pane-head"><h3>Files changed</h3><span>{review.files.length}</span></div>{review.files.length === 0 ? <p className="review-empty">No changed files.</p> : <ul className="review-file-list">{review.files.map((file) => <li key={file.id}><button type="button" className="review-file" data-selected={selected?.id === file.id ? "true" : "false"} onClick={() => setSelectedId(file.id)}><span className="file-copy"><strong>{file.path.split("/").pop()}</strong><span>{file.path}</span></span><span className="diff-stat"><i className="add">+{file.additions}</i><i className="del">−{file.deletions}</i></span></button></li>)}</ul>}</aside>
      <section className="review-pane review-diff" aria-label="Diff preview"><div className="review-pane-head"><h3>{selected?.path ?? "Diff preview"}</h3></div>{selected?.summary && <p className="review-summary">{selected.summary}</p>}{selected && selected.diff.length > 0 ? <pre className="review-code" aria-label={`Diff preview for ${selected.path}`}>{selected.diff.map((line, index) => <span key={`${index}-${line.text}`} className="review-line" data-type={line.type}><i>{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</i><code>{line.text}</code></span>)}</pre> : <p className="review-empty">No diff preview available.</p>}</section>
      <aside className="review-side"><section className="review-pane" aria-label="Integration warnings"><div className="review-pane-head"><h3>Integration</h3><span>{review.warnings.length}</span></div>{review.warnings.length === 0 ? <p className="review-empty">No integration warnings.</p> : <ul className="review-warning-list">{review.warnings.map((warning) => <li key={warning.id} data-severity={warning.severity}><strong>{warning.title}</strong><p>{warning.detail}</p></li>)}</ul>}</section><section className="review-pane" aria-label="Checks"><div className="review-pane-head"><h3>Checks</h3><span>{review.checks.length}</span></div>{review.checks.length === 0 ? <p className="review-empty">No checks reported.</p> : <ul className="review-check-list">{review.checks.map((check) => <li key={check.id}><div><strong>{check.name}</strong>{check.detail && <span>{check.detail}</span>}</div></li>)}</ul>}</section><section className="review-pane review-team-chat" aria-label="Team chat"><div className="review-pane-head"><h3>Team chat</h3><span>{teamChat.filter((message) => message.recipientUserId === null).length}</span></div><TeamChat messages={teamChat} onSend={onSendTeamMessage} participants={participants} currentUserId={currentUserId} /></section></aside>
    </div>
  </section>;
}
