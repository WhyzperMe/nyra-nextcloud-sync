const COUNTER = /^(0|[1-9][0-9]*)$/;

export function randomId(prefix: string): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safePrefix) throw new Error("ID prefix must contain an alphanumeric character.");

  if (typeof globalThis.crypto.randomUUID === "function") {
    return `${safePrefix}_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${safePrefix}_${hex}`;
}

export function assertCounter(value: string, label: string): void {
  if (!COUNTER.test(value)) {
    throw new Error(`${label} must be a non-negative decimal integer string.`);
  }
}

export function incrementCounter(value: string): string {
  assertCounter(value, "counter");
  return (BigInt(value) + 1n).toString();
}

export function compareCounters(left: string, right: string): number {
  assertCounter(left, "left counter");
  assertCounter(right, "right counter");
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function padCounter(value: string, width = 24): string {
  assertCounter(value, "counter");
  if (value.length > width) {
    throw new Error(`Counter ${value} exceeds the supported ${width}-digit filename width.`);
  }
  return value.padStart(width, "0");
}
