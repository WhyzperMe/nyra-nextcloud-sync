import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/state/durable/crypto";
import { BaselineObjectReadLimitError, ObjectStore } from "../src/state/durable/object-store";
import { MemoryStateBackend } from "./helpers/memory-backend";

class ReadCountingBackend extends MemoryStateBackend {
  binaryReads = 0;

  override async readBinary(path: string): Promise<ArrayBuffer> {
    this.binaryReads += 1;
    return await super.readBinary(path);
  }
}

describe("BASE object whole-buffer memory limit", () => {
  it("refuses an oversized object before materializing bytes for verification", async () => {
    const backend = new ReadCountingBackend();
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]).buffer;
    const hash = await sha256Hex(bytes);
    await backend.writeBinary(`objects/${hash.slice(0, 2)}/${hash}.blob`, bytes);
    const store = new ObjectStore(backend, 4);

    await expect(store.hasVerified(hash, bytes.byteLength)).rejects.toBeInstanceOf(BaselineObjectReadLimitError);
    expect(backend.binaryReads).toBe(0);
  });

  it("rejects an oversized streamed BASE before consuming or staging its source", async () => {
    const backend = new ReadCountingBackend();
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]).buffer;
    const hash = await sha256Hex(bytes);
    let consumed = false;
    const chunks = async function* (): AsyncGenerator<ArrayBuffer> {
      consumed = true;
      yield bytes;
    };

    await expect(new ObjectStore(backend, 4).putChunks(chunks(), hash, bytes.byteLength))
      .rejects.toBeInstanceOf(BaselineObjectReadLimitError);
    expect(consumed).toBe(false);
    expect(backend.listAllFiles()).toEqual([]);
  });
});
