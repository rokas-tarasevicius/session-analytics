import type { SessionLike } from "./view-model.js";

export interface QuietRepository { id: string; name: string; lastActiveDay: string }
export function quietRepositories(
  repositories: Array<{ repository: { id: string; name: string } }>,
  sessions: SessionLike[],
  window: { start: string; end: string; timeZone?: string },
): QuietRepository[];
