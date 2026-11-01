import type { DataAdapter } from "obsidian";

export interface StorageCheck { name: string; ok: boolean; detail: string }

const SIZES = [1, 4096, 1024 * 1024, 6 * 1024 * 1024];

/**
 * Exercises the storage calls sync depends on (write then read back, append, rename, stat, list, remove)
 * inside `dir`, so a phone's file layer can be judged by facts instead of guesses. Everything it creates is
 * removed again. Reads are repeated because the failures seen on Android are intermittent short reads.
 */
export async function runStorageSelfTest(adapter: DataAdapter, dir: string): Promise<StorageCheck[]> {
  const checks: StorageCheck[] = [];
  const check = async (name: string, body: () => Promise<string>): Promise<void> => {
    const started = Date.now();
    try {
      const detail = await body();
      checks.push({ name, ok: true, detail: `${detail} (${Date.now() - started} ms)` });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  try {
    await check("Create folder", async () => {
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      if (!(await adapter.exists(dir))) throw new Error("Folder does not exist after mkdir.");
      return "ok";
    });
    await check("Text round trip", async () => {
      const text = "Nyra ✓ äöü 日本語 📱\nline two";
      await adapter.write(`${dir}/t.txt`, text);
      if ((await adapter.read(`${dir}/t.txt`)) !== text) throw new Error("Text came back different.");
      return "ok";
    });
    await check("Recovery-file write (text, then binary, then rename)", async () => {
      const json = JSON.stringify({ version: 2, kind: "replace", targetPath: "Schule/Übung 📱/Aufgabe.md", createdAt: new Date().toISOString() });
      const bytes = new TextEncoder().encode(json);
      const staged = `${dir}/apply_x.json.tmp_y.tmp`;
      await adapter.write(staged, json);
      const stat = await adapter.stat(staged);
      if (!stat || stat.size !== bytes.byteLength) throw new Error(`text write: stat reports ${stat?.size ?? "nothing"} bytes, expected ${bytes.byteLength}.`);
      const text = await adapter.read(staged);
      if (text !== json) throw new Error(`text write: read back ${text.length} of ${json.length} characters.`);
      const binary = new TextDecoder().decode(await adapter.readBinary(staged));
      if (binary !== json) throw new Error(`text write: binary read back ${binary.length} of ${json.length} characters.`);
      await adapter.rename(staged, `${dir}/apply_x.json`);
      if ((await adapter.read(`${dir}/apply_x.json`)) !== json) throw new Error("After the rename the text differs.");
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      await adapter.writeBinary(`${dir}/apply_z.json`, buffer);
      if ((await adapter.read(`${dir}/apply_z.json`)) !== json) throw new Error("A binary write does not read back as the same text.");
      return "ok";
    });
    for (const size of SIZES) {
      await check(`Binary round trip ${size >= 1048576 ? `${size / 1048576} MiB` : `${size} B`}`, async () => {
        const data = new Uint8Array(size).map((_, index) => (index * 31 + 7) & 255);
        const path = `${dir}/b${size}.bin`;
        await adapter.writeBinary(path, data.buffer);
        const stat = await adapter.stat(path);
        if (!stat || stat.size !== size) throw new Error(`stat reports ${stat?.size ?? "nothing"} bytes, expected ${size}.`);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const back = new Uint8Array(await adapter.readBinary(path));
          if (back.byteLength !== size) throw new Error(`read ${attempt} returned ${back.byteLength} bytes, expected ${size}.`);
          for (let index = 0; index < size; index += 4093) if (back[index] !== data[index]) throw new Error(`read ${attempt} differs at byte ${index}.`);
          if (back[size - 1] !== data[size - 1]) throw new Error(`read ${attempt} differs at the last byte.`);
        }
        return "3 reads identical";
      });
    }
    await check("Append", async () => {
      const path = `${dir}/a.bin`;
      await adapter.writeBinary(path, new ArrayBuffer(0));
      for (let part = 0; part < 4; part += 1) await adapter.appendBinary(path, new Uint8Array(1000).fill(part + 1).buffer);
      const back = new Uint8Array(await adapter.readBinary(path));
      if (back.byteLength !== 4000) throw new Error(`4 appends gave ${back.byteLength} bytes, expected 4000.`);
      if (back[0] !== 1 || back[3999] !== 4) throw new Error("Appended bytes are in the wrong order.");
      return "ok";
    });
    await check("Rename into a new folder", async () => {
      await adapter.mkdir(`${dir}/sub`);
      await adapter.rename(`${dir}/a.bin`, `${dir}/sub/a.bin`);
      if (await adapter.exists(`${dir}/a.bin`) || !(await adapter.exists(`${dir}/sub/a.bin`))) throw new Error("Rename did not move the file.");
      return "ok";
    });
    await check("Hidden files are listed", async () => {
      await adapter.write(`${dir}/.hidden`, "x");
      const listing = await adapter.list(dir);
      if (!listing.files.some((file) => file.endsWith("/.hidden"))) throw new Error("A dot-file was not listed.");
      return "ok";
    });
    await check("Modification time moves forward", async () => {
      const path = `${dir}/m.txt`;
      await adapter.write(path, "1");
      const first = await adapter.stat(path);
      await new Promise<void>((resolve) => setTimeout(resolve, 1100));
      await adapter.write(path, "22");
      const second = await adapter.stat(path);
      if (!first || !second) throw new Error("stat returned nothing.");
      if (second.mtime <= first.mtime) throw new Error(`mtime did not advance (${first.mtime} → ${second.mtime}).`);
      return "ok";
    });
  } finally {
    await check("Clean up", async () => {
      if (await adapter.exists(dir)) await adapter.rmdir(dir, true);
      if (await adapter.exists(dir)) throw new Error("Test folder could not be removed.");
      return "ok";
    });
  }
  return checks;
}
