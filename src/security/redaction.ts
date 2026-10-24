const PRIVATE_KEY = /(authorization|password|passwd|secret|token|cookie|credential|app.?password|login.?name|user.?id|file.?id|operation.?key|etag|hash|fingerprint|digest|checksum|paths?$)/i;
const URL_KEY = /(url|uri|href|endpoint)$/i;
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/gi;
const PRIVATE_TEXT_KEY = /(error|message|cause|detail|body|content|note)/i;

export function redact(value: unknown): unknown {
  return redactInner(value, new WeakSet<object>(), null);
}

function redactInner(value: unknown, seen: WeakSet<object>, key: string | null): unknown {
  if (typeof value === "string") {
    if (key === null || (key !== null && PRIVATE_TEXT_KEY.test(key))) return "[REDACTED]";
    return redactUrls(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactInner(entry, seen, null));
  }

  const source = value as Record<string, unknown>;
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(source)) {
    const safeValue = PRIVATE_KEY.test(key)
      ? "[REDACTED]"
      : PRIVATE_TEXT_KEY.test(key) && typeof entry === "string"
        ? "[REDACTED]"
      : typeof entry === "string" && URL_KEY.test(key)
        ? safeUrlForLog(entry)
        : redactInner(entry, seen, key);
    Object.defineProperty(output, key, {
      value: safeValue,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return output;
}

export function safeUrlForLog(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "[invalid-url]";
    return url.origin;
  } catch {
    return "[invalid-url]";
  }
}

function redactUrls(value: string): string {
  return value.replace(URL_IN_TEXT, (candidate) => {
    const trailing = /[),.;!?]+$/.exec(candidate)?.[0] ?? "";
    const url = trailing.length ? candidate.slice(0, -trailing.length) : candidate;
    return `${safeUrlForLog(url)}${trailing}`;
  });
}
