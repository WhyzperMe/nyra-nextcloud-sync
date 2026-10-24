import type { LocalFileMetadata } from "./types";

/** Read-only view of user-visible vault files. This inventory port deliberately exposes no mutation methods. */
export interface LocalFileSource {
  listFiles(): Promise<LocalFileMetadata[]>;
  stat(path: string): Promise<LocalFileMetadata | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
}
