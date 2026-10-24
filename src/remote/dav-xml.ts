/**
 * Minimal namespace-tolerant XML reader for WebDAV multistatus responses.
 * It intentionally supports only the XML constructs needed by DAV and rejects
 * DTD/entity declarations so server input cannot trigger entity expansion.
 */
export interface DavPropertyResponse {
  href: string;
  status: number;
  isCollection: boolean;
  etag: string | null;
  fileId: string | null;
  size: number | null;
  lastModified: string | null;
  contentType: string | null;
  checksums: string[];
  /** Nextcloud trash-bin properties; null outside the trash-bin endpoint. */
  trash?: { filename: string | null; originalLocation: string | null; deletionTime: string | null };
}

export const MAX_DAV_XML_DEPTH = 128;
export const MAX_DAV_XML_ELEMENTS = 250_000;

interface XmlNode {
  name: string;
  text: string;
  children: XmlNode[];
}

export function parseDavMultistatus(xml: string): DavPropertyResponse[] {
  if (xml.length > 64 * 1024 * 1024) throw new Error("WebDAV XML response exceeds the 64 MiB safety limit.");
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error("WebDAV XML contains a forbidden DTD/entity declaration.");
  assertBoundedXmlStructure(xml);
  if (typeof DOMParser !== "undefined") return parseWithDom(xml);

  const root: XmlNode = { name: "#root", text: "", children: [] };
  const stack: XmlNode[] = [root];
  const tokenPattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(xml)) !== null) {
    const token = match[0];
    const current = stack[stack.length - 1];
    if (!current) throw new Error("Malformed WebDAV XML stack.");
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<![CDATA[")) {
      current.text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith("</")) {
      const closing = localName(token.slice(2, -1).trim());
      if (stack.length === 1 || stack[stack.length - 1]?.name !== closing) {
        throw new Error(`Malformed WebDAV XML closing tag '${closing}'.`);
      }
      stack.pop();
      continue;
    }
    if (token.startsWith("<!")) throw new Error("Unsupported WebDAV XML declaration.");
    if (token.startsWith("<")) {
      const selfClosing = /\/\s*>$/.test(token);
      const inside = token.slice(1, selfClosing ? token.lastIndexOf("/") : -1).trim();
      const rawName = inside.split(/\s+/, 1)[0];
      if (!rawName) throw new Error("Malformed WebDAV XML element.");
      const node: XmlNode = { name: localName(rawName), text: "", children: [] };
      current.children.push(node);
      if (!selfClosing) stack.push(node);
      continue;
    }
    current.text += decodeXmlEntities(token);
  }

  if (stack.length !== 1) throw new Error("WebDAV XML ended with unclosed elements.");
  const multistatus = descendants(root, "multistatus")[0] ?? root;
  return childElements(multistatus, "response").map(parseResponse);
}

/** Reject hostile structural complexity before either the DOM or fallback parser allocates a tree. */
function assertBoundedXmlStructure(xml: string): void {
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>/g;
  let depth = 0;
  let elements = 0;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(xml)) !== null) {
    const token = match[0];
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<![CDATA[")) continue;
    if (token.startsWith("<!")) throw new Error("Unsupported WebDAV XML declaration.");
    if (token.startsWith("</")) {
      depth -= 1;
      if (depth < 0) throw new Error("Malformed WebDAV XML closing tag.");
      continue;
    }
    elements += 1;
    if (elements > MAX_DAV_XML_ELEMENTS) throw new Error(`WebDAV XML exceeds the ${MAX_DAV_XML_ELEMENTS}-element safety limit.`);
    if (!/\/\s*>$/.test(token)) {
      depth += 1;
      if (depth > MAX_DAV_XML_DEPTH) throw new Error(`WebDAV XML exceeds the ${MAX_DAV_XML_DEPTH}-level nesting safety limit.`);
    }
  }
  if (depth !== 0) throw new Error("WebDAV XML ended with unclosed elements.");
}

function parseWithDom(xml: string): DavPropertyResponse[] {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) throw new Error("Malformed WebDAV XML response.");
  return Array.from(document.getElementsByTagNameNS("*", "response")).map((response) => {
    const href = domRequiredText(response, "href");
    const propstats = Array.from(response.getElementsByTagNameNS("*", "propstat"));
    let prop: Element | null = null;
    let status = 0;
    for (const propstat of propstats) {
      const candidateStatus = parseStatus(domText(propstat, "status") ?? "");
      if (candidateStatus >= 200 && candidateStatus < 300) {
        prop = firstDirectOrDescendant(propstat, "prop");
        status = candidateStatus;
        if (prop) break;
      }
    }
    if (!prop) {
      prop = firstDirectOrDescendant(response, "prop");
      status = parseStatus(domText(response, "status") ?? "") || 200;
    }
    if (!prop) throw new Error(`WebDAV response for '${href}' contains no successful property set.`);
    const resourceType = firstDirectOrDescendant(prop, "resourcetype");
    const checksums = firstDirectOrDescendant(prop, "checksums");
    return {
      href,
      status,
      isCollection: !!resourceType && resourceType.getElementsByTagNameNS("*", "collection").length > 0,
      etag: domText(prop, "getetag"),
      fileId: domText(prop, "fileid"),
      size: parseNonNegativeInteger(domText(prop, "getcontentlength") ?? domText(prop, "size")),
      lastModified: domText(prop, "getlastmodified"),
      contentType: domText(prop, "getcontenttype"),
      checksums: checksums ? Array.from(checksums.getElementsByTagNameNS("*", "checksum")).map((node) => (node.textContent ?? "").trim()).filter(Boolean) : [],
      trash: { filename: domText(prop, "trashbin-filename"), originalLocation: domText(prop, "trashbin-original-location"), deletionTime: domText(prop, "trashbin-deletion-time") }
    };
  });
}

function domRequiredText(node: Element, local: string): string {
  const value = domText(node, local);
  if (!value) throw new Error(`WebDAV response is missing '${local}'.`);
  return value;
}
function domText(node: Element, local: string): string | null {
  const element = firstDirectOrDescendant(node, local);
  const value = element?.textContent?.trim() ?? "";
  return value || null;
}
function firstDirectOrDescendant(node: Element, local: string): Element | null {
  for (const child of Array.from(node.children)) if (child.localName.toLowerCase() === local) return child;
  return node.getElementsByTagNameNS("*", local)[0] ?? null;
}

function parseResponse(response: XmlNode): DavPropertyResponse {
  const href = requiredText(response, "href");
  const propstats = childElements(response, "propstat");
  let selectedProp: XmlNode | null = null;
  let selectedStatus = 0;
  for (const propstat of propstats) {
    const status = parseStatus(textOf(firstChild(propstat, "status")));
    if (status >= 200 && status < 300) {
      selectedProp = firstChild(propstat, "prop");
      selectedStatus = status;
      if (selectedProp) break;
    }
  }
  if (!selectedProp) {
    selectedProp = firstChild(response, "prop");
    selectedStatus = parseStatus(textOf(firstChild(response, "status"))) || 200;
  }
  if (!selectedProp) throw new Error(`WebDAV response for '${href}' contains no successful property set.`);

  const resourceType = firstChild(selectedProp, "resourcetype");
  const checksums = firstChild(selectedProp, "checksums");
  return {
    href,
    status: selectedStatus,
    isCollection: resourceType ? childElements(resourceType, "collection").length > 0 : false,
    etag: nullableText(selectedProp, "getetag"),
    fileId: nullableText(selectedProp, "fileid"),
    size: parseNonNegativeInteger(nullableText(selectedProp, "getcontentlength") ?? nullableText(selectedProp, "size")),
    lastModified: nullableText(selectedProp, "getlastmodified"),
    contentType: nullableText(selectedProp, "getcontenttype"),
    checksums: checksums ? descendants(checksums, "checksum").map((node) => textOf(node)).filter(Boolean) : [],
    trash: {
      filename: nullableText(selectedProp, "trashbin-filename"),
      originalLocation: nullableText(selectedProp, "trashbin-original-location"),
      deletionTime: nullableText(selectedProp, "trashbin-deletion-time")
    }
  };
}

function childElements(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}
function firstChild(node: XmlNode, name: string): XmlNode | null {
  return childElements(node, name)[0] ?? null;
}
function descendants(node: XmlNode, name: string): XmlNode[] {
  const result: XmlNode[] = [];
  for (const child of node.children) {
    if (child.name === name) result.push(child);
    result.push(...descendants(child, name));
  }
  return result;
}
function requiredText(node: XmlNode, name: string): string {
  const value = nullableText(node, name);
  if (!value) throw new Error(`WebDAV response is missing '${name}'.`);
  return value;
}
function nullableText(node: XmlNode, name: string): string | null {
  const child = firstChild(node, name);
  if (!child) return null;
  const value = textOf(child).trim();
  return value || null;
}
function textOf(node: XmlNode | null): string {
  if (!node) return "";
  return node.text + node.children.map(textOf).join("");
}
function parseStatus(value: string): number {
  const match = /\b(\d{3})\b/.exec(value);
  return match ? Number(match[1]) : 0;
}
function parseNonNegativeInteger(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function localName(raw: string): string {
  const colon = raw.indexOf(":");
  return (colon >= 0 ? raw.slice(colon + 1) : raw).toLowerCase();
}
function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}
