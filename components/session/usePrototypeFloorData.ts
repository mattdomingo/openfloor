"use client";

import { useMemo, useState } from "react";
import type { AppUser, SessionMember } from "@/lib/session-types";
import type { FloorDataSource, FloorParticipant, FloorSnapshot } from "@/lib/floor-types";
import {
  agentFromDraft,
  initialAgents,
  initialAssignments,
  initialQueue,
  initialTeamChat,
  type Agent,
  type Assignment,
  type QueueItem,
  type TeamChatMessage,
} from "./data";

export function usePrototypeFloorData(members: SessionMember[], user: AppUser): FloorDataSource {
  const participants = useMemo(() => floorParticipants(members, user.id), [members, user.id]);
  const [agents, setAgents] = useState<Agent[]>(() => createPrototypeFloorSeed(members, user.id).agents);
  const [assignmentTasks, setAssignmentTasks] = useState<Record<string, string>>({});
  const [queue, setQueue] = useState<QueueItem[]>(() => seedQueue(participants));
  const [messages, setMessages] = useState<TeamChatMessage[]>(() => seedMessages(participants));
  const assignments = useMemo(
    () => seedAssignments(participants).map((assignment) => ({ ...assignment, task: assignmentTasks[assignment.id] ?? assignment.task })),
    [assignmentTasks, participants],
  );

  return {
    kind: "prototype",
    snapshot: { participants, agents, assignments, queue, messages },
    addAgent(draft) {
      const agent = agentFromDraft(draft, agents.length + 1);
      setAgents((current) => [...current, agent]);
      return agent;
    },
    updateAgents(update) {
      setAgents(update);
    },
    updateAssignment(id, task) {
      setAssignmentTasks((current) => ({ ...current, [id]: task }));
    },
    replaceQueue(items) {
      setQueue(items);
    },
    sendMessage(message) {
      setMessages((current) => [...current, message]);
    },
  };
}

export function createPrototypeFloorSeed(members: SessionMember[], currentUserId: string): FloorSnapshot {
  const participants = floorParticipants(members, currentUserId);
  return {
    participants,
    agents: seedAgents(participants),
    assignments: seedAssignments(participants),
    queue: seedQueue(participants),
    messages: seedMessages(participants),
  };
}

export function floorParticipants(members: SessionMember[], currentUserId: string): FloorParticipant[] {
  return members.map((member, index) => ({
    id: member.id,
    name: member.displayName,
    initials: initials(member.displayName),
    tone: member.id === currentUserId ? "you" : `member-${index}`,
    role: member.role,
    online: member.online,
    isCurrentUser: member.id === currentUserId,
  }));
}

function seedAgents(participants: FloorParticipant[]): Agent[] {
  const people = participants.length > 0 ? participants : [{ name: "You" }];
  let ownerIndex = 0;
  return initialAgents.map((agent) => {
    if (agent.owner === "System") return { ...agent };
    const owner = people[ownerIndex % people.length].name;
    ownerIndex += 1;
    return { ...agent, owner };
  });
}

function seedAssignments(participants: FloorParticipant[]): Assignment[] {
  return participants.map((participant, index) => ({
    ...(initialAssignments[index % initialAssignments.length] ?? initialAssignments[0]),
    id: participant.id,
    name: participant.name,
    initials: participant.initials,
    tone: participant.tone,
    state: participant.online ? "Online" : "Offline",
    stateTone: participant.online ? "running" : "waiting",
  }));
}

function seedQueue(participants: FloorParticipant[]): QueueItem[] {
  const people = participants.length > 0 ? participants : [{ name: "You", tone: "you" }];
  return initialQueue.map((item, index) => {
    const author = people[index % people.length];
    return { ...item, author: index === 1 ? "You" : author.name, authorTone: index === 1 ? "you" : author.tone };
  });
}

function seedMessages(participants: FloorParticipant[]): TeamChatMessage[] {
  if (participants.length === 0) return [];
  return initialTeamChat.slice(0, Math.max(3, participants.length)).map((message, index) => {
    const author = participants[index % participants.length];
    return {
      ...message,
      id: `prototype-${index + 1}`,
      authorId: author.id,
      authorName: author.name,
      authorTone: author.tone,
      dmWith: undefined,
    };
  });
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}
