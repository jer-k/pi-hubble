import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { Vault } from "../extensions/hubble-vault.ts";

test("skips a crowded slug namespace while preserving the first gap and existing files", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "hubble-slug-collisions-"));
  try {
    for (let index = 1; index <= 100; index++) {
      if (index !== 42) await fs.writeFile(join(root, `note${index === 1 ? "" : `-${index}`}.md`), "existing");
    }
    // Directories also occupy names and must never be opened as new notes.
    await fs.mkdir(join(root, "note-42.md"));
    await fs.unlink(join(root, "note-43.md"));
    const opened = await Vault.open(root);

    if (opened.status === "error") throw opened.error;

    const created = await opened.value.create("Note", "new body");
    expect(created).toMatchObject({ status: "ok", value: { relative: "note-43.md" } });
    expect(await fs.readFile(join(root, "note-43.md"), "utf8")).toBe("# Note\n\nnew body");
    expect(await fs.readFile(join(root, "note-100.md"), "utf8")).toBe("existing");
    expect((await fs.stat(join(root, "note-42.md"))).isDirectory()).toBe(true);
    expect(await opened.value.create("Note", "must not overwrite", "", "markdown", "note-43.md")).toMatchObject({
      status: "error",
      error: { _tag: "NoteWriteError", cause: { _tag: "ExistingFileError", cause: { code: "EEXIST" } } },
    });
    expect(await fs.readFile(join(root, "note-43.md"), "utf8")).toBe("# Note\n\nnew body");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an external create after the snapshot cannot be overwritten", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "hubble-slug-race-"));
  await fs.writeFile(join(root, "note.md"), "existing");
  try {
    const opened = await Vault.open(root, {
      ...fs,
      async readdir(path, options) {
        const entries = await fs.readdir(path, options);
        await fs.writeFile(join(root, "note-2.md"), "external");
        return entries;
      },
    });

    if (opened.status === "error") throw opened.error;

    expect(await opened.value.create("Note", "new body")).toMatchObject({
      status: "ok",
      value: { relative: "note-3.md" },
    });
    expect(await fs.readFile(join(root, "note-2.md"), "utf8")).toBe("external");
    expect(await fs.readFile(join(root, "note-3.md"), "utf8")).toBe("# Note\n\nnew body");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("falls back to exclusive-open allocation when optional directory reads fail", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "hubble-slug-unreadable-"));
  await fs.writeFile(join(root, "note.md"), "existing");
  const cause = Object.assign(new Error("directory not readable"), { code: "EACCES" });
  try {
    const opened = await Vault.open(root, {
      ...fs,
      async readdir() {
        throw cause;
      },
    });

    if (opened.status === "error") throw opened.error;

    expect(await opened.value.create("Note", "body")).toMatchObject({ status: "ok", value: { relative: "note-2.md" } });
    expect(await fs.readFile(join(root, "note.md"), "utf8")).toBe("existing");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("preserves a new candidate's structured open failure after skipping collisions", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "hubble-slug-failure-"));
  await fs.writeFile(join(root, "note.md"), "existing");
  await fs.writeFile(join(root, "note-2.md"), "existing");
  const cause = Object.assign(new Error("write denied"), { code: "EACCES" });
  try {
    const opened = await Vault.open(root, {
      ...fs,
      async open(path, flags, mode) {
        if (path.endsWith("note-3.md")) throw cause;
        return fs.open(path, flags, mode);
      },
    });

    if (opened.status === "error") throw opened.error;

    expect(await opened.value.create("Note", "body")).toMatchObject({
      status: "error",
      error: { _tag: "NoteWriteError", cause },
    });
    expect(await fs.readdir(root)).toEqual(["note-2.md", "note.md"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent crowded-slug creates remain unique and complete", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "hubble-slug-concurrent-"));
  try {
    for (let index = 1; index <= 50; index++) {
      await fs.writeFile(join(root, `note${index === 1 ? "" : `-${index}`}.md`), "existing");
    }
    const opened = await Vault.open(root);

    if (opened.status === "error") throw opened.error;

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => opened.value.create("Note", `body ${index}`))
    );
    const paths: string[] = [];
    for (const [index, result] of results.entries()) {
      expect(result.status).toBe("ok");

      if (result.status === "error") throw result.error;

      paths.push(result.value.relative);
      expect(await fs.readFile(result.value.absolute, "utf8")).toBe(`# Note\n\nbody ${index}`);
    }
    expect(new Set(paths).size).toBe(8);
    expect(await fs.readFile(join(root, "note-50.md"), "utf8")).toBe("existing");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test.each(["open", "snapshot"] as const)("rejects a symlink escape introduced during collision %s", async (phase) => {
  const base = await fs.mkdtemp(join(tmpdir(), "hubble-slug-symlink-race-"));
  const root = join(base, "vault");
  const folder = join(root, "folder");
  const outside = join(base, "outside");
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(join(folder, "note.md"), "existing");
  await fs.writeFile(join(outside, "note-2.md"), "private");
  const replace = async () => {
    await fs.rename(folder, join(root, "original"));
    await fs.symlink(outside, folder);
  };
  try {
    const opened = await Vault.open(root, {
      ...fs,
      async open(path, flags, mode) {
        try {
          return await fs.open(path, flags, mode);
        } catch (cause) {
          if (phase === "open") await replace();
          throw cause;
        }
      },
      async readdir(path, options) {
        const entries = await fs.readdir(path, options);
        if (phase === "snapshot") await replace();
        return entries;
      },
    });

    if (opened.status === "error") throw opened.error;

    expect(await opened.value.create("Note", "must stay inside", "folder")).toMatchObject({
      status: "error",
      error: { _tag: "VaultPathError", reason: "symlink-escape" },
    });
    expect(await fs.readdir(outside)).toEqual(["note-2.md"]);
    expect(await fs.readFile(join(outside, "note-2.md"), "utf8")).toBe("private");
    expect(await fs.readFile(join(root, "original", "note.md"), "utf8")).toBe("existing");
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
