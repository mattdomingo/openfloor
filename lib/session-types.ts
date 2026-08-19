export type SessionRole = "owner" | "member";

export type SessionSummary = {
  id: string;
  title: string;
  objective: string | null;
  role: SessionRole;
  memberCount: number;
  createdAt: number;
  updatedAt: number;
};

export type SessionMember = {
  id: string;
  displayName: string;
  role: SessionRole;
  joinedAt: number;
  online: boolean;
};

export type PresenceEvent =
  | { type: "presence.snapshot"; onlineUserIds: string[] }
  | { type: "presence.changed"; userId: string; online: boolean }
  | { type: "members.changed" }
  | { type: "session.changed"; objective: string | null; updatedAt: number }
  | { type: "floor.changed"; revision: number; domains: import("./floor-types").FloorDomain[] }
  | { type: "error"; code: string };

export type AppUser = {
  id: string;
  providerUserId: string;
  email: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
};
