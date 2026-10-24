/** Deterministic JSON used for WAL/snapshot checksums. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON does not allow non-finite numbers.");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) {
        throw new Error(`Canonical JSON does not allow undefined values (key: ${key}).`);
      }
      output[key] = canonicalize(entry);
    }
    return output;
  }

  throw new Error(`Canonical JSON does not support values of type ${typeof value}.`);
}
