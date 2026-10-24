/** Preserve the production DAV request while enforcing acceptance transport bounds. */
export function acceptanceRequestOptions(
  authorization: string,
  method: string,
  extraHeaders: Record<string, string>,
  body: Uint8Array | undefined,
  defaultPropfindBody: string,
  timeoutMs: number
): RequestInit {
  const headers = new Headers({ Authorization: authorization, ...extraHeaders });
  if (method === "PROPFIND") {
    headers.set("Content-Type", "application/xml; charset=utf-8");
    headers.set("Accept", "application/xml");
  }
  const options: RequestInit = { method, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) options.body = body;
  else if (method === "PROPFIND") options.body = defaultPropfindBody;
  return options;
}
