import { closeSync, fsyncSync, openSync } from "node:fs";

/** Make a file creation, rename, or removal durable in its parent directory. */
export function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
