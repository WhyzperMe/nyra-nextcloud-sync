export function canonicalVaultRelativePath(input: string): string {
  let value = input.replace(/\\/g, "/");
  value = value.replace(/^\.\//, "").replace(/\/{2,}/g, "/");

  if (!value || value.startsWith("/") || /^[A-Za-z]:\//.test(value)) {
    throw new Error(`Expected a vault-relative path, got '${input}'.`);
  }
  if (value.endsWith("/")) {
    throw new Error(`File path may not end with '/': ${input}`);
  }

  const parts = value.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new Error(`Invalid path segment in '${input}'.`);
    }
    if (/\0|[\u0001-\u001f\u007f]/.test(part)) {
      throw new Error("Vault-relative paths may not contain control characters.");
    }
  }
  return parts.join("/");
}
