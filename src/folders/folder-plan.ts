/**
 * Three-way folder reconciliation (LOCAL / REMOTE / BASE) for directories.
 *
 * File replicas are handled by the transactional file engine. Folders carry no
 * content, so the only evidence needed is presence. A folder is deleted on one
 * side only when it was previously confirmed on both sides (BASE) and has since
 * vanished from the other side; a folder that was never confirmed is always
 * treated as newly created and mirrored, never deleted.
 */
export interface FolderPlanInput {
  local: ReadonlySet<string>;
  remote: ReadonlySet<string>;
  baseline: ReadonlySet<string>;
  allowDeletes: boolean;
  /** Folders (and their ancestors) that still contain a file on the given replica. */
  localOccupied: ReadonlySet<string>;
  remoteOccupied: ReadonlySet<string>;
}

export interface FolderPlan {
  createRemote: string[];
  createLocal: string[];
  deleteRemote: string[];
  deleteLocal: string[];
  /** Folder baseline after the planned operations succeed. */
  nextBaseline: Set<string>;
}

export function planFolderSync(input: FolderPlanInput): FolderPlan {
  const { local, remote, baseline, allowDeletes, localOccupied, remoteOccupied } = input;
  const createRemote: string[] = [];
  const createLocal: string[] = [];
  const deleteRemote: string[] = [];
  const deleteLocal: string[] = [];
  const next = new Set<string>();

  for (const path of new Set([...local, ...remote, ...baseline])) {
    const inLocal = local.has(path);
    const inRemote = remote.has(path);
    const known = baseline.has(path);
    if (inLocal && inRemote) { next.add(path); continue; }
    if (!inLocal && !inRemote) continue; // gone on both sides: forget it
    if (inLocal) {
      if (!known) { createRemote.push(path); next.add(path); }
      else if (!allowDeletes || localOccupied.has(path)) next.add(path); // remote deletion, local content remains: keep and let files decide
      else deleteLocal.push(path);
    } else if (!known) { createLocal.push(path); next.add(path); }
    else if (!allowDeletes || remoteOccupied.has(path)) next.add(path);
    else deleteRemote.push(path);
  }

  // Parents before children when creating, children before parents when deleting.
  createRemote.sort(byDepthThenName);
  createLocal.sort(byDepthThenName);
  deleteRemote.sort((a, b) => byDepthThenName(b, a));
  deleteLocal.sort((a, b) => byDepthThenName(b, a));
  return { createRemote, createLocal, deleteRemote, deleteLocal, nextBaseline: next };
}

/** Marks every ancestor directory of each file path as occupied. */
export function occupiedDirectories(filePaths: Iterable<string>): Set<string> {
  const occupied = new Set<string>();
  for (const file of filePaths) {
    let slash = file.lastIndexOf("/");
    while (slash > 0) {
      const directory = file.slice(0, slash);
      if (occupied.has(directory)) break;
      occupied.add(directory);
      slash = directory.lastIndexOf("/");
    }
  }
  return occupied;
}

function depth(path: string): number { return path.split("/").length; }
function byDepthThenName(a: string, b: string): number {
  return depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0);
}
