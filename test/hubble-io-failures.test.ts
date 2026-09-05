import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import type { NoteFileHandle, NoteFileSystem } from "../extensions/hubble-notes.ts";
import { truncateOutput } from "../extensions/hubble-tools.ts";
import { openVault } from "../extensions/hubble-vault.ts";

function systemError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function fixture(fileSystem: NoteFileSystem = fs) {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-hubble-io-"));
  const opened = await openVault(root, fileSystem);
  if (opened.status === "error") throw opened.error;
  return {
    root,
    vault: opened.value,
    async [Symbol.asyncDispose]() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** Wraps a real handle, preserving all operations except the explicitly injected failure. */
function handles(replace: (handle: fs.FileHandle) => NoteFileHandle): NoteFileSystem {
  return {
    ...fs,
    async open(path, flags, mode) {
      return replace(await fs.open(path, flags, mode));
    },
  };
}

function handleOperations(handle: fs.FileHandle): NoteFileHandle {
  return {
    chmod: handle.chmod.bind(handle),
    close: handle.close.bind(handle),
    sync: handle.sync.bind(handle),
    writeFile: handle.writeFile.bind(handle),
  };
}

test("classifies HTML create open failures through Vault.create", async () => {
  const cause = systemError("permission denied", "EACCES");
  await using f = await fixture({
    ...fs,
    async open() {
      throw cause;
    },
  });
  const result = await f.vault.create("Open Failure", "<p>body</p>", "", "html");
  expect(result).toMatchObject({ status: "error", error: { _tag: "NoteWriteError", cause } });
  expect(await fs.readdir(f.root)).toEqual([]);
});

test("closes the real create handle and removes an incomplete note after a write failure", async () => {
  const cause = systemError("disk full", "ENOSPC");
  let openedHandle: fs.FileHandle | undefined;
  await using f = await fixture(
    handles((handle) => {
      openedHandle = handle;
      return {
        ...handleOperations(handle),
        async writeFile() {
          throw cause;
        },
      };
    })
  );
  const result = await f.vault.create("Write Failure", "body");
  expect(result).toMatchObject({ status: "error", error: { _tag: "NoteWriteError", cause } });
  if (!openedHandle) throw new Error("Expected a real file handle");
  await expect(openedHandle.stat()).rejects.toMatchObject({ code: "EBADF" });
  expect(await fs.readdir(f.root)).toEqual([]);
});

test.each(["create", "edit"] as const)("preserves %s and cleanup failures", async (operation) => {
  const writeCause = systemError("disk full", "ENOSPC");
  const cleanupCause = systemError("cleanup denied", "EACCES");
  await using f = await fixture({
    ...handles((handle) => ({
      ...handleOperations(handle),
      async writeFile() {
        throw writeCause;
      },
    })),
    async unlink() {
      throw cleanupCause;
    },
  });
  await fs.writeFile(join(f.root, "note.md"), "old");
  const result =
    operation === "create"
      ? await f.vault.create("New", "body")
      : await f.vault.edit("note.md", [{ oldText: "old", newText: "new" }]);
  expect(result.status).toBe("error");
  if (result.status !== "error" || result.error._tag !== "NoteWriteError") throw new Error("Expected write error");
  const aggregate = result.error.cause;
  if (!(aggregate instanceof AggregateError)) throw new Error("Expected aggregate failure");
  expect(aggregate.errors[0]).toMatchObject({ _tag: "NoteWriteError", cause: writeCause });
  expect(aggregate.errors[1]).toBe(cleanupCause);
  expect(await fs.readFile(join(f.root, "note.md"), "utf8")).toBe("old");
});

test("returns a structured read failure through the injected filesystem", async () => {
  const cause = systemError("read denied", "EACCES");
  await using f = await fixture({
    ...fs,
    async readFile() {
      throw cause;
    },
  });
  await fs.writeFile(join(f.root, "note.md"), "old");
  expect(await f.vault.read("note.md")).toMatchObject({ status: "error", error: { _tag: "NoteReadError", cause } });
});

test.each(["writeFile", "chmod", "sync", "close", "rename"] as const)(
  "keeps the original and cleans up when edit %s fails",
  async (operation) => {
    const cause = systemError("edit failed", "EIO");
    const fileSystem = handles((handle) => {
      const operations = handleOperations(handle);
      if (operation !== "rename")
        operations[operation] = async () => {
          if (operation === "close") await handle.close();
          throw cause;
        };
      return operations;
    });
    await using f = await fixture({
      ...fileSystem,
      async rename(from, to) {
        if (operation === "rename") throw cause;
        await fs.rename(from, to);
      },
    });
    await fs.writeFile(join(f.root, "note.md"), "old");
    const result = await f.vault.edit("note.md", [{ oldText: "old", newText: "new" }]);
    expect(result).toMatchObject({ status: "error", error: { _tag: "NoteWriteError", cause } });
    expect(await fs.readFile(join(f.root, "note.md"), "utf8")).toBe("old");
    expect(await fs.readdir(f.root)).toEqual(["note.md"]);
  }
);

test("cancels an atomic edit before rename and removes its temporary file", async () => {
  const controller = new AbortController();
  await using f = await fixture(
    handles((handle) => ({
      ...handleOperations(handle),
      async sync() {
        await handle.sync();
        controller.abort(new Error("cancelled"));
      },
    }))
  );
  await fs.writeFile(join(f.root, "note.md"), "old");
  await expect(f.vault.edit("note.md", [{ oldText: "old", newText: "new" }], controller.signal)).rejects.toThrow(
    "cancelled"
  );
  expect(await fs.readFile(join(f.root, "note.md"), "utf8")).toBe("old");
  expect(await fs.readdir(f.root)).toEqual(["note.md"]);
});

test("fails safely when truncated output cannot be persisted", async () => {
  const cause = systemError("temporary directory unavailable", "EACCES");
  expect(
    await truncateOutput("line\n".repeat(3_000), {
      ...fs,
      async mkdtemp() {
        throw cause;
      },
    })
  ).toMatchObject({ status: "error", error: { _tag: "OutputPersistenceError", cause } });
  await using f = await fixture();
  const writeCause = systemError("temporary write failed", "ENOSPC");
  expect(
    await truncateOutput("line\n".repeat(3_000), {
      async mkdtemp() {
        return f.root;
      },
      async writeFile() {
        throw writeCause;
      },
    })
  ).toMatchObject({ status: "error", error: { _tag: "OutputPersistenceError", cause: writeCause } });
});
