import * as actualFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Result } from "better-result";
import { beforeEach, expect, test, vi } from "vitest";

import type { NoteFileHandle, NoteFileSystem } from "../extensions/hubble-notes.ts";
import { type OutputFileSystem, truncateOutput } from "../extensions/hubble-tools.ts";
import { openVault } from "../extensions/hubble-vault.ts";

const fsMocks = {
  mkdtemp: vi.fn((prefix: string) => actualFs.mkdtemp(prefix)),
  open: vi.fn((path: string, flags: "wx", mode?: number): Promise<NoteFileHandle> => actualFs.open(path, flags, mode)),
  readFile: vi.fn((path: string, encoding: "utf8") => actualFs.readFile(path, encoding)),
  rename: vi.fn((oldPath: string, newPath: string) => actualFs.rename(oldPath, newPath)),
  unlink: vi.fn((path: string) => actualFs.unlink(path)),
  writeFile: vi.fn((path: string, data: string, encoding: "utf8") => actualFs.writeFile(path, data, encoding)),
};

const noteFileSystem = {
  access: actualFs.access,
  mkdir: actualFs.mkdir,
  open: fsMocks.open,
  readdir: actualFs.readdir,
  readFile: fsMocks.readFile,
  rename: fsMocks.rename,
  stat: actualFs.stat,
  unlink: fsMocks.unlink,
} satisfies NoteFileSystem;

const outputFileSystem = {
  mkdtemp: fsMocks.mkdtemp,
  writeFile: fsMocks.writeFile,
} satisfies OutputFileSystem;

function systemError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function vaultAt(root: string) {
  const result = await openVault(root, noteFileSystem);
  if (Result.isError(result)) throw result.error;
  return result.value;
}

beforeEach(() => {
  vi.clearAllMocks();
  fsMocks.mkdtemp.mockImplementation((prefix) => actualFs.mkdtemp(prefix));
  fsMocks.open.mockImplementation((path, flags, mode) => actualFs.open(path, flags, mode));
  fsMocks.readFile.mockImplementation((path, encoding) => actualFs.readFile(path, encoding));
  fsMocks.rename.mockImplementation((oldPath, newPath) => actualFs.rename(oldPath, newPath));
  fsMocks.unlink.mockImplementation((path) => actualFs.unlink(path));
  fsMocks.writeFile.mockImplementation((path, data, encoding) => actualFs.writeFile(path, data, encoding));
});

test("classifies HTML create open failures through Vault.create", async () => {
  const root = await actualFs.mkdtemp(join(tmpdir(), "pi-hubble-io-open-"));
  const vault = await vaultAt(root);
  const cause = systemError("permission denied", "EACCES");
  fsMocks.open.mockRejectedValueOnce(cause);

  const result = await vault.create("Open Failure", "<p>body</p>", "", "html");
  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.error._tag).toBe("NoteWriteError");
    if (result.error._tag === "NoteWriteError") expect(result.error.cause).toBe(cause);
  }
});

test("closes the create handle and removes the incomplete note after a write failure", async () => {
  const root = await actualFs.mkdtemp(join(tmpdir(), "pi-hubble-io-write-"));
  const vault = await vaultAt(root);
  const cause = systemError("disk full", "ENOSPC");
  const writeFile = vi.fn().mockRejectedValue(cause);
  const close = vi.fn();
  fsMocks.open.mockImplementationOnce(async (path: string, flags: "wx"): Promise<NoteFileHandle> => {
    const handle = await actualFs.open(path, flags);
    close.mockImplementation(() => handle.close());
    return {
      chmod: handle.chmod.bind(handle),
      close,
      sync: handle.sync.bind(handle),
      writeFile,
    };
  });

  const result = await vault.create("Write Failure", "body");
  expect(writeFile).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  await expect(actualFs.readFile(join(root, "write-failure.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(result.status).toBe("error");
  if (result.status === "error" && result.error._tag === "NoteWriteError") expect(result.error.cause).toBe(cause);
});

test("preserves creation and cleanup failures when an incomplete note cannot be removed", async () => {
  const root = await actualFs.mkdtemp(join(tmpdir(), "pi-hubble-io-cleanup-"));
  const vault = await vaultAt(root);
  const writeCause = systemError("disk full", "ENOSPC");
  const cleanupCause = systemError("cleanup denied", "EACCES");
  const close = vi.fn().mockResolvedValue(undefined);
  fsMocks.open.mockResolvedValueOnce({
    chmod: vi.fn(),
    close,
    sync: vi.fn(),
    writeFile: vi.fn().mockRejectedValue(writeCause),
  });
  fsMocks.unlink.mockRejectedValueOnce(cleanupCause);

  const result = await vault.create("Cleanup Failure", "body");

  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.error._tag).toBe("NoteWriteError");
    if (result.error._tag === "NoteWriteError") {
      expect(result.error.cause).toBeInstanceOf(AggregateError);
      const aggregate = result.error.cause;
      if (!(aggregate instanceof AggregateError)) throw new Error("Expected aggregate creation and cleanup failures");
      const causes = aggregate.errors;
      expect(causes[0]).toMatchObject({ _tag: "NoteWriteError", cause: writeCause });
      expect(causes[1]).toBe(cleanupCause);
    }
  }
});

test("maps Vault read and atomic edit I/O failures without changing the note", async () => {
  const root = await actualFs.mkdtemp(join(tmpdir(), "pi-hubble-io-note-"));
  const vault = await vaultAt(root);
  const created = await vault.create("Note", "old");
  if (created.status === "error") throw created.error;

  const readCause = systemError("read denied", "EACCES");
  fsMocks.readFile.mockRejectedValueOnce(readCause);
  const read = await vault.read(created.value.relative);
  expect(read.status).toBe("error");
  if (read.status === "error" && read.error._tag === "NoteReadError") expect(read.error.cause).toBe(readCause);

  fsMocks.readFile.mockImplementation((path, encoding) => actualFs.readFile(path, encoding));
  const editCause = systemError("disk full", "ENOSPC");
  fsMocks.open.mockImplementationOnce(async (path: string, flags: "wx", mode?: number): Promise<NoteFileHandle> => {
    const handle = await actualFs.open(path, flags, mode);
    return {
      chmod: handle.chmod.bind(handle),
      close: handle.close.bind(handle),
      sync: handle.sync.bind(handle),
      writeFile: vi.fn().mockRejectedValue(editCause),
    };
  });

  const edit = await vault.edit(created.value.relative, [{ oldText: "old", newText: "new" }]);
  expect(edit.status).toBe("error");
  if (edit.status === "error" && edit.error._tag === "NoteWriteError") expect(edit.error.cause).toBe(editCause);
  expect(await actualFs.readFile(created.value.absolute, "utf8")).toBe("# Note\n\nold");
  expect(await actualFs.readdir(root)).toEqual(["note.md"]);
});

test("preserves atomic edit and temporary-file cleanup failures", async () => {
  const root = await actualFs.mkdtemp(join(tmpdir(), "pi-hubble-io-edit-cleanup-"));
  const vault = await vaultAt(root);
  const created = await vault.create("Edit Cleanup", "old");
  if (created.status === "error") throw created.error;
  const writeCause = systemError("disk full", "ENOSPC");
  const cleanupCause = systemError("cleanup denied", "EACCES");
  fsMocks.open.mockImplementationOnce(async (path: string, flags: "wx", mode?: number): Promise<NoteFileHandle> => {
    const handle = await actualFs.open(path, flags, mode);
    return {
      chmod: handle.chmod.bind(handle),
      close: handle.close.bind(handle),
      sync: handle.sync.bind(handle),
      writeFile: vi.fn().mockRejectedValue(writeCause),
    };
  });
  fsMocks.unlink.mockRejectedValueOnce(cleanupCause);

  const edit = await vault.edit(created.value.relative, [{ oldText: "old", newText: "new" }]);

  expect(edit.status).toBe("error");
  if (edit.status === "error" && edit.error._tag === "NoteWriteError") {
    expect(edit.error.cause).toBeInstanceOf(AggregateError);
    const aggregate = edit.error.cause;
    if (!(aggregate instanceof AggregateError)) throw new Error("Expected aggregate edit and cleanup failures");
    const causes = aggregate.errors;
    expect(causes[0]).toMatchObject({ _tag: "NoteWriteError", cause: writeCause });
    expect(causes[1]).toBe(cleanupCause);
  }
  expect(await actualFs.readFile(created.value.absolute, "utf8")).toBe("# Edit Cleanup\n\nold");
});

test("keeps the original note when the atomic edit rename fails", async () => {
  const root = await actualFs.mkdtemp(join(tmpdir(), "pi-hubble-io-rename-"));
  const vault = await vaultAt(root);
  const created = await vault.create("Rename Note", "old");
  if (created.status === "error") throw created.error;
  const cause = systemError("rename failed", "EIO");
  fsMocks.rename.mockRejectedValueOnce(cause);

  const edit = await vault.edit(created.value.relative, [{ oldText: "old", newText: "new" }]);

  expect(edit.status).toBe("error");
  if (edit.status === "error" && edit.error._tag === "NoteWriteError") expect(edit.error.cause).toBe(cause);
  expect(await actualFs.readFile(created.value.absolute, "utf8")).toBe("# Rename Note\n\nold");
  expect(await actualFs.readdir(root)).toEqual(["rename-note.md"]);
});

test("cancels an atomic edit before rename and removes its temporary file", async () => {
  const root = await actualFs.mkdtemp(join(tmpdir(), "pi-hubble-io-cancel-"));
  const vault = await vaultAt(root);
  const created = await vault.create("Cancel Note", "old");
  if (created.status === "error") throw created.error;
  const controller = new AbortController();
  fsMocks.open.mockImplementationOnce(async (path: string, flags: "wx", mode?: number): Promise<NoteFileHandle> => {
    const handle = await actualFs.open(path, flags, mode);
    return {
      chmod: handle.chmod.bind(handle),
      close: handle.close.bind(handle),
      writeFile: handle.writeFile.bind(handle),
      sync: async () => {
        await handle.sync();
        controller.abort(new Error("cancelled"));
      },
    };
  });

  await expect(
    vault.edit(created.value.relative, [{ oldText: "old", newText: "new" }], controller.signal)
  ).rejects.toThrow("cancelled");
  expect(await actualFs.readFile(created.value.absolute, "utf8")).toBe("# Cancel Note\n\nold");
  expect(await actualFs.readdir(root)).toEqual(["cancel-note.md"]);
});

test("fails safely when truncated output cannot be persisted", async () => {
  const cause = systemError("temporary directory unavailable", "EACCES");
  fsMocks.mkdtemp.mockRejectedValueOnce(cause);
  const result = await truncateOutput("line\n".repeat(3_000), outputFileSystem);
  expect(result.status).toBe("error");
  if (result.status === "error") expect(result.error.cause).toBe(cause);

  fsMocks.mkdtemp.mockImplementation((prefix) => actualFs.mkdtemp(prefix));
  fsMocks.writeFile.mockRejectedValueOnce(systemError("temporary write failed", "ENOSPC"));
  const persisted = await truncateOutput("line\n".repeat(3_000), outputFileSystem);
  expect(persisted.status).toBe("error");
  if (persisted.status === "error") expect(persisted.error._tag).toBe("OutputPersistenceError");
});
