import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  mkdtemp: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, ...fsMocks };
});

import {
  appendToVaultFile,
  editVaultFile,
  readVaultFile,
  truncateOutput,
  writeNewVaultFile,
} from "../extensions/hubble-vault.ts";

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

function systemError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  vi.clearAllMocks();
  fsMocks.mkdtemp.mockImplementation(actualFs.mkdtemp);
  fsMocks.open.mockImplementation(actualFs.open);
  fsMocks.readFile.mockImplementation(actualFs.readFile);
  fsMocks.writeFile.mockImplementation(actualFs.writeFile);
});

test("classifies create open failures and preserves their cause", async () => {
  const root = await actualFs.mkdtemp(join(tmpdir(), "pi-hubble-io-open-"));
  const cause = systemError("permission denied", "EACCES");
  fsMocks.open.mockRejectedValueOnce(cause);

  const result = await writeNewVaultFile({ root }, "Open Failure", "body");

  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.error._tag).toBe("NoteWriteError");
    if (result.error._tag === "NoteWriteError") {
      expect(result.error.operation).toBe("create");
      expect(result.error.cause).toBe(cause);
    }
  }
});

test("closes the create handle after a write failure", async () => {
  const root = await actualFs.mkdtemp(join(tmpdir(), "pi-hubble-io-write-"));
  const cause = systemError("disk full", "ENOSPC");
  const close = vi.fn().mockResolvedValue(undefined);
  const writeFile = vi.fn().mockRejectedValue(cause);
  fsMocks.open.mockResolvedValueOnce({ close, writeFile });

  const result = await writeNewVaultFile({ root }, "Write Failure", "body");

  expect(writeFile).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(result.status).toBe("error");
  if (result.status === "error" && result.error._tag === "NoteWriteError") {
    expect(result.error.operation).toBe("create");
    expect(result.error.cause).toBe(cause);
  }
});

test("classifies create close failures after a successful write", async () => {
  const root = await actualFs.mkdtemp(join(tmpdir(), "pi-hubble-io-close-"));
  const cause = systemError("close failed", "EIO");
  const close = vi.fn().mockRejectedValue(cause);
  const writeFile = vi.fn().mockResolvedValue(undefined);
  fsMocks.open.mockResolvedValueOnce({ close, writeFile });

  const result = await writeNewVaultFile({ root }, "Close Failure", "body");

  expect(writeFile).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(result.status).toBe("error");
  if (result.status === "error" && result.error._tag === "NoteWriteError") {
    expect(result.error.operation).toBe("create");
    expect(result.error.cause).toBe(cause);
  }
});

test("maps read, append, and edit I/O failures to reusable note errors", async () => {
  const root = await actualFs.mkdtemp(join(tmpdir(), "pi-hubble-io-note-"));
  const absolute = join(root, "note.md");
  const path = { absolute, relative: "note.md" };
  await actualFs.writeFile(absolute, "old", "utf8");

  const readCause = systemError("read denied", "EACCES");
  fsMocks.readFile.mockRejectedValueOnce(readCause);
  const read = await readVaultFile(path);
  expect(read.status).toBe("error");
  if (read.status === "error" && read.error._tag === "NoteReadError") expect(read.error.cause).toBe(readCause);

  fsMocks.readFile.mockImplementation(actualFs.readFile);
  const appendCause = systemError("append failed", "EIO");
  fsMocks.writeFile.mockRejectedValueOnce(appendCause);
  const append = await appendToVaultFile(path, "new");
  expect(append.status).toBe("error");
  if (append.status === "error" && append.error._tag === "NoteWriteError") {
    expect(append.error.operation).toBe("append");
    expect(append.error.cause).toBe(appendCause);
  }

  const editCause = systemError("edit failed", "EIO");
  fsMocks.writeFile.mockRejectedValueOnce(editCause);
  const edit = await editVaultFile(path, [{ oldText: "old", newText: "new" }]);
  expect(edit.status).toBe("error");
  if (edit.status === "error" && edit.error._tag === "NoteWriteError") {
    expect(edit.error.operation).toBe("edit");
    expect(edit.error.cause).toBe(editCause);
  }

  expect(await actualFs.readFile(absolute, "utf8")).toBe("old");
});

test("fails safely when the truncated output directory cannot be created", async () => {
  const cause = systemError("temporary directory unavailable", "EACCES");
  fsMocks.mkdtemp.mockRejectedValueOnce(cause);

  const result = await truncateOutput("line\n".repeat(3_000));

  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.error._tag).toBe("OutputPersistenceError");
    expect(result.error.cause).toBe(cause);
  }
});

test("fails safely instead of returning untruncated output when persistence fails", async () => {
  const cause = systemError("temporary write failed", "ENOSPC");
  fsMocks.writeFile.mockRejectedValueOnce(cause);

  const result = await truncateOutput("line\n".repeat(3_000));

  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.error._tag).toBe("OutputPersistenceError");
    expect(result.error.cause).toBe(cause);
  }
});
