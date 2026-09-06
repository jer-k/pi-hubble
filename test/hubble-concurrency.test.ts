import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import { Vault } from "../extensions/hubble-vault.ts";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Pauses a create after opening its destination while a competing file-queue operation registers. */
test.each(["success", "failure"] as const)("coordinates creation with the destination queue on %s", async (outcome) => {
  const root = await fs.mkdtemp(join(tmpdir(), "hubble-create-queue-"));
  const opened = deferred();
  const release = deferred();
  let writerReleased = false;
  const cause = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  try {
    const result = await Vault.open(root, {
      ...fs,
      async open(path, flags, mode) {
        const handle = await fs.open(path, flags, mode);
        return {
          chmod: handle.chmod.bind(handle),
          close: handle.close.bind(handle),
          sync: handle.sync.bind(handle),
          async writeFile(body, encoding) {
            opened.resolve();
            await release.promise;

            if (outcome === "failure") {
              throw cause;
            }

            await handle.writeFile(body, encoding);
          },
        };
      },
    });

    if (result.status === "error") {
      throw result.error;
    }

    const creating = result.value.create("Note", "body");
    await opened.promise;
    const target = join(root, "note.md");
    // This is the same public Pi queue used by note reads and edits.
    const competing = withFileMutationQueue(target, async () => {
      const startedAfterRelease = writerReleased;
      const content = await fs.readFile(target, "utf8").catch((error: Error) => error);
      return { startedAfterRelease, content };
    });
    const reading = result.value.read("note.md");
    // Pi registers queue requests serially. A different-file barrier proves the contender
    // registered without relying on a timing delay or waiting for the held file queue.
    await withFileMutationQueue(join(root, "barrier"), async () => {});
    writerReleased = true;
    release.resolve();
    const created = await creating;
    const observed = await competing;
    expect(observed.startedAfterRelease).toBe(true);

    if (outcome === "success") {
      expect(created.status).toBe("ok");
      expect(observed.content).toBe("# Note\n\nbody");
      expect(await reading).toMatchObject({ status: "ok", value: { content: "# Note\n\nbody" } });
    } else {
      expect(created).toMatchObject({ status: "error", error: { _tag: "NoteWriteError", cause } });
      expect(observed.content).toMatchObject({ code: "ENOENT" });
      expect(await reading).toMatchObject({ status: "error", error: { _tag: "NoteNotFoundError" } });
    }
  } finally {
    release.resolve();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test.each(["save", "replace", "delete", "unchanged"] as const)(
  "checks external %s before committing an edit",
  async (action) => {
    const root = await fs.mkdtemp(join(tmpdir(), "hubble-edit-conflict-"));
    const path = join(root, "note.md");
    await fs.writeFile(path, "old");
    try {
      const opened = await Vault.open(root, {
        ...fs,
        async open(file, flags, mode) {
          const handle = await fs.open(file, flags, mode);
          return {
            chmod: handle.chmod.bind(handle),
            close: handle.close.bind(handle),
            writeFile: handle.writeFile.bind(handle),
            async sync() {
              await handle.sync();

              if (action === "save") {
                await fs.writeFile(path, "Hubble save");
              }

              if (action === "replace") {
                await fs.writeFile(join(root, "replacement"), "old");
                await fs.rename(join(root, "replacement"), path);
              }

              if (action === "delete") {
                await fs.unlink(path);
              }
            },
          };
        },
      });

      if (opened.status === "error") {
        throw opened.error;
      }

      const result = await opened.value.edit("note.md", [{ oldText: "old", newText: "new" }]);

      if (action === "unchanged") {
        expect(result.status).toBe("ok");
        expect(await fs.readFile(path, "utf8")).toBe("new");
      } else if (action === "delete") {
        expect(result).toMatchObject({
          status: "error",
          error: { _tag: "NoteWriteError", cause: { _tag: "MissingFileError", cause: { code: "ENOENT" } } },
        });
        expect(await fs.readdir(root)).toEqual([]);
      } else {
        expect(result).toMatchObject({ status: "error", error: { _tag: "NoteConflictError" } });
        expect(await fs.readFile(path, "utf8")).toBe(action === "save" ? "Hubble save" : "old");
      }
      expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
);
