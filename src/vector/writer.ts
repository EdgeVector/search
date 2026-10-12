import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** No timeout expiry: an interrupted writer lock requires explicit owner recovery. */
export function acquireWriterLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Search writer is busy or has an interrupted-owner lock: ${path}`,
      );
    }
    throw e;
  }
  const owned = fstatSync(fd);
  const release = () => {
    try {
      const current = lstatSync(path);
      if (
        !current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino
      ) {
        throw new Error(`Search writer lock identity changed: ${path}`);
      }
      unlinkSync(path);
    } finally {
      closeSync(fd);
    }
  };
  try {
    writeFileSync(fd, JSON.stringify({
      version: 1,
      pid: process.pid,
      acquired_at: new Date().toISOString(),
    }));
  } catch (e) {
    release();
    throw e;
  }
  return release;
}
