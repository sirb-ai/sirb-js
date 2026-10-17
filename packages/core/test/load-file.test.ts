// loadSpecFile must never hang, grow without bound, or follow what a path
// points at: it reads only regular files of at most 1 MiB, and only up to
// maxBytes + 1 bytes even when the file grows after fstat.
import { execFileSync } from "node:child_process";
import {
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { loadSpecFile } from "../src/index.js";
import { readSpecFile } from "../src/read-file.js";

const MAX = 1024 * 1024;
const agentYaml = `apiVersion: sirb/v1alpha1
kind: Agent
metadata: { name: support-agent }
spec:
  modelBinding: claude-default
  instructions: Be helpful.
`;
const posix = process.platform !== "win32";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sirb-core-read-"));
  writeFileSync(join(dir, "agent.yaml"), agentYaml);
  writeFileSync(join(dir, "exact.yaml"), `# ${"x".repeat(MAX - 3)}\n`);
  writeFileSync(join(dir, "big.yaml"), "");
  truncateSync(join(dir, "big.yaml"), 64 * MAX); // sparse: cheap to create
  mkdirSync(join(dir, "dir.yaml"));
  if (posix) {
    symlinkSync(join(dir, "agent.yaml"), join(dir, "link.yaml"));
    execFileSync("mkfifo", [join(dir, "fifo.yaml")]);
    symlinkSync(join(dir, "fifo.yaml"), join(dir, "link-to-fifo.yaml"));
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

/** Spies on FileHandle#read and #stat (shared by every handle). */
async function spyHandle() {
  const probe = await open(join(dir, "agent.yaml"), "r");
  const proto = Object.getPrototypeOf(probe) as {
    read: (...args: unknown[]) => Promise<{ bytesRead: number }>;
    stat: () => Promise<unknown>;
  };
  await probe.close();
  return { read: vi.spyOn(proto, "read"), stat: vi.spyOn(proto, "stat") };
}

const ioIssue = (reason: string) => ({
  valid: false,
  documents: [],
  issues: [
    {
      code: "io",
      severity: "error",
      message: `cannot read the file: ${reason}`,
    },
  ],
});

describe("loadSpecFile reads only bounded regular files", () => {
  it("loads a regular file, and accepts exactly 1 MiB", async () => {
    expect((await loadSpecFile(join(dir, "agent.yaml"))).valid).toBe(true);
    const exact = await loadSpecFile(join(dir, "exact.yaml"));
    expect(exact.issues.map((i) => i.code)).toEqual(["empty"]);
  });

  it("rejects an oversized file from fstat, without reading it", async () => {
    const { read } = await spyHandle();
    const r = await loadSpecFile(join(dir, "big.yaml"));
    expect(r).toEqual({
      valid: false,
      documents: [],
      issues: [
        {
          code: "too-large",
          severity: "error",
          message: `input exceeds ${MAX} bytes`,
        },
      ],
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("reads at most maxBytes + 1 when fstat under-reports the size (growth, /proc)", async () => {
    const { read, stat } = await spyHandle();
    stat.mockResolvedValue({ isFile: () => true, size: 0 });
    writeFileSync(join(dir, "grown.yaml"), "a".repeat(3 * MAX));
    const r = await loadSpecFile(join(dir, "grown.yaml"));
    expect(r.issues.map((i) => i.code)).toEqual(["too-large"]);
    let total = 0;
    for (const result of read.mock.results) {
      total += ((await result.value) as { bytesRead: number }).bytesRead;
    }
    expect(total).toBe(MAX + 1);
  });

  it("rejects a directory", async () => {
    expect(await loadSpecFile(join(dir, "dir.yaml"))).toEqual(
      ioIssue("a directory"),
    );
  });

  it("reports a missing file by errno only, never the path", async () => {
    expect(await loadSpecFile(join(dir, "missing.yaml"))).toEqual(
      ioIssue("ENOENT"),
    );
  });

  it.skipIf(!posix)(
    "rejects a FIFO at once instead of waiting for a writer",
    async () => {
      const started = performance.now();
      expect(await loadSpecFile(join(dir, "fifo.yaml"))).toEqual(
        ioIssue("a FIFO"),
      );
      expect(performance.now() - started).toBeLessThan(1000);
    },
  );

  it.skipIf(!existsSync("/dev/zero"))(
    "rejects /dev/zero without reading it",
    async () => {
      const { read } = await spyHandle();
      expect(await loadSpecFile("/dev/zero")).toEqual(ioIssue("a device"));
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.skipIf(!posix)(
    "rejects a symlink by default and follows it on request",
    async () => {
      expect(await loadSpecFile(join(dir, "link.yaml"))).toEqual(
        ioIssue("a symbolic link"),
      );
      const followed = await loadSpecFile(join(dir, "link.yaml"), {
        followSymlinks: true,
      });
      expect(followed.valid).toBe(true);
      expect(followed.documents[0]?.metadata.name).toBe("support-agent");
    },
  );

  it.skipIf(!posix)(
    "still checks the target of a followed symlink",
    async () => {
      expect(
        await loadSpecFile(join(dir, "link-to-fifo.yaml"), {
          followSymlinks: true,
        }),
      ).toEqual(ioIssue("a FIFO"));
    },
  );

  it("reports read failures after open as io issues and closes the handle", async () => {
    const { read } = await spyHandle();
    read.mockRejectedValue(Object.assign(new Error("boom"), { code: "EIO" }));
    expect(await loadSpecFile(join(dir, "agent.yaml"))).toEqual(ioIssue("EIO"));
    read.mockRejectedValue(new Error("no code"));
    expect(await loadSpecFile(join(dir, "agent.yaml"))).toEqual(
      ioIssue("unknown error"),
    );
  });
});

describe("readSpecFile without O_NOFOLLOW (the Windows path)", () => {
  const { O_NOFOLLOW: _omit, ...withoutNoFollow } = constants;

  it.skipIf(!posix)("falls back to lstat to reject a symlink", async () => {
    const r = await readSpecFile(
      join(dir, "link.yaml"),
      false,
      withoutNoFollow,
    );
    expect(r).toMatchObject({ ok: false, issue: { code: "io" } });
    expect(r.ok ? "" : r.issue.message).toBe(
      "cannot read the file: a symbolic link",
    );
  });

  it("reads a regular file and reports a missing one", async () => {
    const ok = await readSpecFile(
      join(dir, "agent.yaml"),
      false,
      withoutNoFollow,
    );
    expect(ok.ok && new TextDecoder().decode(ok.bytes)).toBe(agentYaml);
    const missing = await readSpecFile(join(dir, "nope.yaml"), false, {});
    expect(missing.ok ? "" : missing.issue.message).toBe(
      "cannot read the file: ENOENT",
    );
  });
});
