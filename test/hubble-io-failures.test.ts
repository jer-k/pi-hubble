import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  mkdtemp: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, ...fsMocks };
});

import { Result } from "better-result";
import { openVault } from "../extensions/hubble-vault.ts";
import { truncateOutput } from "../extensions/hubble-tools.ts";

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

function systemError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function vaultAt(root: string) {
  const result = await openVault(root);
  if (Result.isError(result)) throw result.error;
  return result.value;
}

beforeEach(() => {
  vi.clearAllMocks();
  fsMocks.mkdtemp.mockImplementation(actualFs.mkdtemp);
  fsMocks.open.mockImplementation(actualFs.open);
  fsMocks.readFile.mockImplementation(actualFs.readFile);
  fsMocks.unlink.mockImplementation(actualFs.unlink);
  fsMocks.writeFile.mockImplementation(actualFs.writeFile);
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
  fsMocks.open.mockImplementationOnce(async (path: string, flags: string) => {
    const handle = await actualFs.open(path, flags);
    close.mockImplementation(() => handle.close());
    return { close, writeFile };
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
  fsMocks.open.mockResolvedValueOnce({ close, writeFile: vi.fn().mockRejectedValue(writeCause) });
  fsMocks.unlink.mockRejectedValueOnce(cleanupCause);

  const result = await vault.create("Cleanup Failure", "body");

  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.error._tag).toBe("NoteWriteError");
    if (result.error._tag === "NoteWriteError") {
      expect(result.error.cause).toBeInstanceOf(AggregateError);
      const causes = (result.error.cause as AggregateError).errors;
      expect(causes[0]).toMatchObject({ _tag: "NoteWriteError", cause: writeCause });
      expect(causes[1]).toBe(cleanupCause);
    }
  }
});

test("maps Vault read, append, and edit I/O failures", async () => {
  const root = await actualFs.mkdtemp(join(tmpdir(), "pi-hubble-io-note-"));
  const vault = await vaultAt(root);
  const created = await vault.create("Note", "old");
  if (created.status === "error") throw created.error;

  const readCause = systemError("read denied", "EACCES");
  fsMocks.readFile.mockRejectedValueOnce(readCause);
  const read = await vault.read(created.value.relative);
  expect(read.status).toBe("error");
  if (read.status === "error" && read.error._tag === "NoteReadError") expect(read.error.cause).toBe(readCause);

  fsMocks.readFile.mockImplementation(actualFs.readFile);
  const appendCause = systemError("append failed", "EIO");
  fsMocks.writeFile.mockRejectedValueOnce(appendCause);
  const append = await vault.append(created.value.relative, "new");
  expect(append.status).toBe("error");
  if (append.status === "error" && append.error._tag === "NoteWriteError") expect(append.error.cause).toBe(appendCause);

  const editCause = systemError("edit failed", "EIO");
  fsMocks.writeFile.mockRejectedValueOnce(editCause);
  const edit = await vault.edit(created.value.relative, [{ oldText: "old", newText: "new" }]);
  expect(edit.status).toBe("error");
  if (edit.status === "error" && edit.error._tag === "NoteWriteError") expect(edit.error.cause).toBe(editCause);
});

test("fails safely when truncated output cannot be persisted", async () => {
  const cause = systemError("temporary directory unavailable", "EACCES");
  fsMocks.mkdtemp.mockRejectedValueOnce(cause);
  const result = await truncateOutput("line\n".repeat(3_000));
  expect(result.status).toBe("error");
  if (result.status === "error") expect(result.error.cause).toBe(cause);

  fsMocks.mkdtemp.mockImplementation(actualFs.mkdtemp);
  fsMocks.writeFile.mockRejectedValueOnce(systemError("temporary write failed", "ENOSPC"));
  const persisted = await truncateOutput("line\n".repeat(3_000));
  expect(persisted.status).toBe("error");
  if (persisted.status === "error") expect(persisted.error._tag).toBe("OutputPersistenceError");
});
