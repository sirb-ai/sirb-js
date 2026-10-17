import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { DEFAULT_LIMITS } from "@sirb/spec";
import type { SpecIssue } from "./issues.js";

export type ReadResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly issue: SpecIssue };

const io = (reason: string): ReadResult => ({
  ok: false,
  issue: {
    code: "io",
    severity: "error",
    message: `cannot read the file: ${reason}`,
  },
});

const tooLarge = (): ReadResult => ({
  ok: false,
  issue: {
    code: "too-large",
    severity: "error",
    message: `input exceeds ${DEFAULT_LIMITS.maxBytes} bytes`,
  },
});

/** An errno code such as ENOENT; never the error message (it repeats the path). */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)
    ? code
    : "unknown error";
}

function kindOf(stats: Stats): string {
  if (stats.isDirectory()) return "a directory";
  if (stats.isFIFO()) return "a FIFO";
  if (stats.isSocket()) return "a socket";
  if (stats.isCharacterDevice() || stats.isBlockDevice()) return "a device";
  if (stats.isSymbolicLink()) return "a symbolic link";
  return "not a regular file";
}

/**
 * Reads a spec file without trusting what the path points at.
 *
 * - Opened with `O_NONBLOCK`, so a FIFO cannot block the open (and a libuv
 *   thread) waiting for a writer.
 * - Opened with `O_NOFOLLOW` unless `followSymlinks`. It only applies to the
 *   last path component: symlinks in parent directories are still followed.
 *   Where the platform has no `O_NOFOLLOW` (Windows), an `lstat` check is used
 *   instead, which is subject to a check-then-open race.
 * - `fstat` on the open handle must report a regular file of at most
 *   `maxBytes`; devices such as /dev/zero, FIFOs, sockets and directories are
 *   rejected before any read.
 * - At most `maxBytes + 1` bytes are read, so a file that grows after `fstat`
 *   is still bounded and reported as `too-large`.
 *
 * Never throws or rejects. `flagSet` defaults to `fs.constants`; tests pass
 * one without `O_NOFOLLOW` to exercise the Windows path.
 */
export async function readSpecFile(
  path: string,
  followSymlinks: boolean,
  flagSet: Partial<typeof constants> = constants,
): Promise<ReadResult> {
  const { maxBytes } = DEFAULT_LIMITS;
  const { O_RDONLY = 0, O_NONBLOCK, O_NOFOLLOW } = flagSet;
  let flags = O_RDONLY | (O_NONBLOCK ?? 0);
  if (!followSymlinks) {
    if (O_NOFOLLOW !== undefined) {
      flags |= O_NOFOLLOW;
    } else {
      try {
        if ((await lstat(path)).isSymbolicLink()) return io("a symbolic link");
      } catch (error) {
        return io(errorCode(error));
      }
    }
  }

  let handle: FileHandle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    // O_NOFOLLOW on a symlink fails with ELOOP (EMLINK on some BSDs).
    const code = errorCode(error);
    return !followSymlinks && (code === "ELOOP" || code === "EMLINK")
      ? io("a symbolic link")
      : io(code);
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return io(kindOf(stats));
    if (stats.size > maxBytes) return tooLarge();
    // Sized from fstat plus one byte to detect growth; grows (to maxBytes + 1 at
    // most) for files whose reported size is wrong, such as /proc entries.
    const limit = maxBytes + 1;
    let buffer = new Uint8Array(Math.min(stats.size + 1, limit));
    let length = 0;
    for (;;) {
      if (length === buffer.length) {
        if (buffer.length === limit) break;
        const grown = new Uint8Array(Math.min(buffer.length * 2 + 4096, limit));
        grown.set(buffer);
        buffer = grown;
      }
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) return tooLarge();
    return { ok: true, bytes: buffer.subarray(0, length) };
  } catch (error) {
    return io(errorCode(error));
  } finally {
    await handle.close().catch(() => undefined);
  }
}
