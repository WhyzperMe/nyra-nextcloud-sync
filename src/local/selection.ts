import { normalizeFolder } from "./user-rules";

/**
 * The file picker's selection model. The user unchecks items; each unchecked path is stored in
 * `excludes`. A folder excludes everything below it, so the list stays short and survives new files.
 */
export type SelectionState = "included" | "excluded" | "partial";

const parentOf = (path: string): string => { const slash = path.lastIndexOf("/"); return slash < 0 ? "" : path.slice(0, slash); };
const isUnder = (path: string, folder: string): boolean => path.startsWith(`${folder}/`);

/** Canonical, de-duplicated list without entries made redundant by an excluded ancestor. */
export function normalizeExcludes(entries: readonly string[]): string[] {
  const canonical = [...new Set(entries.flatMap((entry) => { const path = normalizeFolder(entry); return path ? [path] : []; }))].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const kept: string[] = [];
  for (const path of canonical) if (!kept.some((ancestor) => path === ancestor || isUnder(path, ancestor))) kept.push(path);
  return kept.sort();
}

/** An item is excluded when it or an ancestor is listed; partial when only descendants are listed. */
export function selectionState(path: string, excludes: readonly string[]): SelectionState {
  for (const entry of excludes) if (path === entry || isUnder(path, entry)) return "excluded";
  for (const entry of excludes) if (isUnder(entry, path)) return "partial";
  return "included";
}

/** Direct child paths of a folder (local and remote combined); used to carve an item out of an excluded folder. */
export type ListChildren = (folder: string) => Promise<readonly string[]>;

/**
 * Applies a check/uncheck. Re-including an item below an excluded ancestor keeps the ancestor's other
 * children excluded, by replacing the ancestor with its remaining children along the path.
 */
export async function setIncluded(excludes: readonly string[], rawPath: string, included: boolean, listChildren: ListChildren): Promise<string[]> {
  const path = normalizeFolder(rawPath);
  if (!path) return [...excludes];
  const current = normalizeExcludes(excludes);
  if (!included) return normalizeExcludes([...current, path]);

  const ancestor = current.find((entry) => path === entry || isUnder(path, entry));
  let next = current.filter((entry) => entry !== path && !isUnder(entry, path));
  if (!ancestor) return next;
  next = next.filter((entry) => entry !== ancestor);
  if (ancestor === path) return next;
  const segments = path.split("/");
  const depth = ancestor.split("/").length;
  const carved: string[] = [];
  for (let level = depth; level < segments.length; level += 1) {
    const folder = segments.slice(0, level).join("/");
    const keep = segments.slice(0, level + 1).join("/");
    for (const child of await listChildren(folder)) if (child !== keep) carved.push(child);
  }
  return normalizeExcludes([...next, ...carved]);
}

export { parentOf };
