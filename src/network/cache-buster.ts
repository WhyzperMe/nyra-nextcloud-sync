/**
 * Appends a unique query parameter. Some HTTP stacks (notably iOS) cache a GET response by URL and then add
 * their own `If-None-Match` validator to a later PUT/MOVE/DELETE of the same URL, which a server answers with
 * 412. A URL that was never requested before has no cache entry to validate.
 */
export function withCacheBuster(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("nyra_nc", Math.random().toString(36).slice(2, 10));
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * True when a 412 explains that an If-None-Match precondition matched although the request never sent one:
 * the HTTP stack added it from a cached response, and the refused write never ran.
 */
export function isInjectedIfNoneMatch(request: { method?: string; headers?: Record<string, string> }, response: { status: number; text: string }): boolean {
  const method = request.method ?? "GET";
  if (response.status !== 412 || method === "GET" || method === "HEAD") return false;
  if (Object.keys(request.headers ?? {}).some((name) => name.toLowerCase() === "if-none-match")) return false;
  return /if-none-match/i.test(typeof response.text === "string" ? response.text : "");
}
