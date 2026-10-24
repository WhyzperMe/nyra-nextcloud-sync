/** Obsidian readBinary materializes an entire file, so boundaries are inclusive and checked before a read begins. */
export function isWithinLocalReadBudget(sizeBytes: number, limitBytes: number): boolean {
  return Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 && Number.isSafeInteger(limitBytes) && limitBytes > 0 && sizeBytes <= limitBytes;
}
