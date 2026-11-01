/**
 * Base64 flavour of the LZ-string codec, bit-compatible with the `lz-string` library that the Excalidraw
 * plugin uses for the `compressed-json` block of `.excalidraw.md` files. Written out here (about 150 lines)
 * so the plugin keeps zero runtime dependencies.
 */
const KEY = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const REVERSE = new Map<string, number>([...KEY].map((char, index) => [char, index]));

export function compressToBase64(input: string): string {
  const result = compress(input, 6, (value) => KEY.charAt(value));
  switch (result.length % 4) {
    case 1: return `${result}===`;
    case 2: return `${result}==`;
    case 3: return `${result}=`;
    default: return result;
  }
}

/** Returns null for input that is not a valid stream. */
export function decompressFromBase64(input: string): string | null {
  if (input === "") return null;
  return decompress(input.length, 32, (index) => REVERSE.get(input.charAt(index)) ?? 0);
}

function compress(source: string, bitsPerChar: number, charFromInt: (value: number) => string): string {
  // The reference implementation keys its dictionary by the concatenated strings. A (prefix code, next char)
  // trie yields the identical code sequence without building those strings, which is several times faster
  // on multi-megabyte drawings.
  const singles = new Map<number, number>();
  const pendingSingles = new Set<number>();
  const trie = new Map<number, number>();
  const output: string[] = [];
  let dataVal = 0;
  let dataPosition = 0;
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  let w = -1; // code of the current word, -1 while empty
  let wChar = -1; // char code when the current word is a single character

  const writeBit = (bit: number): void => {
    dataVal = (dataVal << 1) | bit;
    if (dataPosition === bitsPerChar - 1) {
      dataPosition = 0;
      output.push(charFromInt(dataVal));
      dataVal = 0;
    } else dataPosition += 1;
  };
  const writeBits = (value: number, count: number): void => {
    let v = value;
    for (let i = 0; i < count; i += 1) { writeBit(v & 1); v >>= 1; }
  };
  const tick = (): void => {
    enlargeIn -= 1;
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits += 1; }
  };
  const emit = (): void => {
    if (wChar >= 0 && pendingSingles.has(wChar)) {
      if (wChar < 256) {
        writeBits(0, numBits);
        writeBits(wChar, 8);
      } else {
        writeBits(1, numBits);
        writeBits(wChar, 16);
      }
      tick();
      pendingSingles.delete(wChar);
    } else {
      writeBits(w, numBits);
    }
    tick();
  };

  for (let index = 0; index < source.length; index += 1) {
    const cc = source.charCodeAt(index);
    let single = singles.get(cc);
    if (single === undefined) {
      single = dictSize;
      dictSize += 1;
      singles.set(cc, single);
      pendingSingles.add(cc);
    }
    if (w === -1) {
      w = single;
      wChar = cc;
      continue;
    }
    const key = w * 65536 + cc;
    const found = trie.get(key);
    if (found !== undefined) {
      w = found;
      wChar = -1;
    } else {
      emit();
      trie.set(key, dictSize);
      dictSize += 1;
      w = single;
      wChar = cc;
    }
  }
  if (w !== -1) emit();
  writeBits(2, numBits); // end of stream
  while (true) { // flush the last partial character
    dataVal <<= 1;
    if (dataPosition === bitsPerChar - 1) { output.push(charFromInt(dataVal)); break; }
    dataPosition += 1;
  }
  return output.join("");
}

function decompress(length: number, resetValue: number, nextValue: (index: number) => number): string | null {
  const dictionary: string[] = [];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  const result: string[] = [];
  let dataVal = nextValue(0);
  let dataPosition = resetValue;
  let dataIndex = 1;

  const readBits = (count: number): number => {
    let bits = 0;
    let power = 1;
    const max = 2 ** count;
    while (power !== max) {
      const bit = dataVal & dataPosition;
      dataPosition >>= 1;
      if (dataPosition === 0) {
        dataPosition = resetValue;
        dataVal = nextValue(dataIndex);
        dataIndex += 1;
      }
      bits |= (bit > 0 ? 1 : 0) * power;
      power <<= 1;
    }
    return bits;
  };

  for (let i = 0; i < 3; i += 1) dictionary[i] = String(i);
  let c: string;
  switch (readBits(2)) {
    case 0: c = String.fromCharCode(readBits(8)); break;
    case 1: c = String.fromCharCode(readBits(16)); break;
    default: return "";
  }
  dictionary[3] = c;
  let w = c;
  result.push(c);
  while (true) {
    if (dataIndex > length) return "";
    let code = readBits(numBits);
    if (code === 0 || code === 1) {
      dictionary[dictSize] = String.fromCharCode(readBits(code === 0 ? 8 : 16));
      code = dictSize;
      dictSize += 1;
      enlargeIn -= 1;
    } else if (code === 2) {
      return result.join("");
    }
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits += 1; }
    let entry: string;
    const known = dictionary[code];
    if (known !== undefined) entry = known;
    else if (code === dictSize) entry = w + w.charAt(0);
    else return null;
    result.push(entry);
    dictionary[dictSize] = w + entry.charAt(0);
    dictSize += 1;
    enlargeIn -= 1;
    w = entry;
    if (enlargeIn === 0) { enlargeIn = 2 ** numBits; numBits += 1; }
  }
}
