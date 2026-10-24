export type ServerHealthState =
  | "unknown"
  | "checking"
  | "online"
  | "offline"
  | "maintenance"
  | "degraded"
  | "auth-required";

export interface ServerHealthSnapshot {
  state: ServerHealthState;
  checkedAt: string | null;
  nextCheckAt: string | null;
  lastOnlineAt: string | null;
  consecutiveFailures: number;
  message: string;
  serverVersionString: string | null;
}
