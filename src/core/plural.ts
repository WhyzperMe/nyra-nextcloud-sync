const NUMBER = new Intl.NumberFormat();

/** "1 file", "2 files": a count with the right noun form, never "file(s)". The last word is pluralized. */
export function plural(count: number, noun: string): string {
  return `${NUMBER.format(count)} ${count === 1 ? noun : `${noun}s`}`;
}

/** "is" for one, "are" otherwise. */
export function isAre(count: number): string { return count === 1 ? "is" : "are"; }

/** "needs" for one, "need" otherwise. */
export function needs(count: number): string { return count === 1 ? "needs" : "need"; }
