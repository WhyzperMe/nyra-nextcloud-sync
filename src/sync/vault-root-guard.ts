import type { RemoteFullScanResult } from "../remote/types";

export interface LocalRootEvidence { path: string; size: number }

/**
 * A pasted parent folder can make a vault replicate into <vault>/<vault>.
 * This check is deliberately conservative: file names and sizes are only
 * evidence for blocking, never authority to select a new root or write data.
 */
export function assertVaultRootMapping(
  scan: RemoteFullScanResult,
  vaultName: string,
  localFiles: readonly LocalRootEvidence[],
  remoteRootPath: string
): void {
  if (!vaultName || vaultName.includes("/")) return;
  if (!scan.entries.some((entry) => entry.path.startsWith(`${vaultName}/`))) return;
  const remoteByPath = new Map(scan.entries.map((entry) => [entry.path, entry]));
  let direct = 0;
  let nested = 0;
  for (const { path, size } of localFiles) {
    if (path.startsWith(`${vaultName}/`) || path.startsWith(".obsidian/")) continue;
    if (remoteByPath.get(path)?.size === size) direct += 1;
    if (remoteByPath.get(`${vaultName}/${path}`)?.size === size) nested += 1;
  }
  if (nested >= 2 && nested > direct) {
    const suggested = [remoteRootPath.replace(/\/+$/, ""), vaultName].filter(Boolean).join("/");
    throw new Error(`Possible vault folder mismatch: the remote folder contains matching files under '${vaultName}/'. No files were changed. Review the remote folder setting; '${suggested}' may be the intended folder. Existing nested copies require manual review.`);
  }
}
