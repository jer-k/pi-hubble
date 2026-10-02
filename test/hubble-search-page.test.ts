import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { Vault } from "../extensions/hubble-vault.ts";

test("restricts paged search recursively to a safely resolved folder", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "hubble-page-folder-"));
  const outside = await fs.mkdtemp(join(tmpdir(), "hubble-page-folder-outside-"));

  try {
    await fs.mkdir(join(root, "tickets", "TODO"), { recursive: true });
    await fs.writeFile(join(root, "tickets", "direct.md"), "flat growth direct");
    await fs.writeFile(join(root, "tickets", "TODO", "nested.md"), "flat growth nested");
    await fs.writeFile(join(root, "outside.md"), "flat growth outside");
    await fs.mkdir(join(root, "unrelated"));
    await fs.writeFile(join(root, "unrelated", "note.md"), "flat growth unrelated");
    await fs.symlink(outside, join(root, "external"), "dir");
    const scanCause = Object.assign(new Error("unrelated directory is unreadable"), { code: "EACCES" });
    const opened = await Vault.open(root, {
      ...fs,
      async readdir(path, options) {
        if (path.endsWith("/unrelated")) {
          throw scanCause;
        }

        return fs.readdir(path, options);
      },
      async readFile(path, encoding) {
        if (path.endsWith("outside.md")) {
          throw new Error("out-of-scope note must not be read");
        }

        return fs.readFile(path, encoding);
      },
    });

    if (opened.status === "error") {
      throw opened.error;
    }

    const page = await opened.value.searchPage("FLAT GROWTH", {
      folder: "@hubble/tickets/",
      offset: 1,
      limit: 10,
    });
    expect(page).toMatchObject({
      status: "ok",
      value: {
        hasMore: false,
        results: [{ note: { relative: "tickets/direct.md" } }, { note: { relative: "tickets/TODO/nested.md" } }],
      },
    });
    expect(await opened.value.searchPage("match", { folder: "../outside", offset: 1, limit: 1 })).toMatchObject({
      status: "error",
      error: { _tag: "VaultPathError", reason: "escape" },
    });
    expect(await opened.value.searchPage("match", { folder: "external", offset: 1, limit: 1 })).toMatchObject({
      status: "error",
      error: { _tag: "VaultPathError", reason: "symlink-escape" },
    });
    expect(await opened.value.searchPage("flat growth", { folder: "unrelated", offset: 1, limit: 1 })).toMatchObject({
      status: "error",
      error: { _tag: "VaultDiscoveryError", reason: "scan", cause: scanCause },
    });
    expect(await opened.value.search("flat growth")).toMatchObject({
      status: "error",
      error: { _tag: "VaultDiscoveryError", reason: "scan", cause: scanCause },
    });
    expect(await opened.value.searchPage("flat growth", { folder: "missing", offset: 1, limit: 1 })).toMatchObject({
      status: "error",
      error: {
        _tag: "VaultDiscoveryError",
        reason: "scan",
        cause: { _tag: "MissingFileError", cause: { code: "ENOENT" } },
      },
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("stops reading after page lookahead and preserves unbounded search behavior", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "hubble-page-"));
  try {
    await fs.writeFile(join(root, "a.md"), "match 1\nmatch 2\nmatch 3\nmatch 4");
    await fs.writeFile(join(root, "z.md"), "match 5");
    const cause = new Error("later file unavailable");
    const opened = await Vault.open(root, {
      ...fs,
      async readFile(path, encoding) {
        if (path.endsWith("z.md")) {
          throw cause;
        }

        return fs.readFile(path, encoding);
      },
    });

    if (opened.status === "error") {
      throw opened.error;
    }

    const page = await opened.value.searchPage("MATCH", { offset: 2, limit: 1 });
    expect(page).toMatchObject({
      status: "ok",
      value: { hasMore: true, results: [{ matches: [{ line: 2, text: "match 2" }] }] },
    });
    expect(await opened.value.search("match")).toMatchObject({
      status: "error",
      error: { _tag: "NoteReadError", cause },
    });

    for (const options of [
      { offset: 0, limit: 1 },
      { offset: 1, limit: 501 },
      { offset: 1.5, limit: 1 },
    ]) {
      expect(await opened.value.searchPage("match", options)).toMatchObject({
        status: "error",
        error: { _tag: "NoteValidationError", reason: "pagination" },
      });
    }

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(opened.value.searchPage("match", { offset: 1, limit: 1 }, controller.signal)).rejects.toThrow(
      "cancelled"
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test.each(["scope", "child"] as const)(
  "scoped search rejects a %s replaced by an external symlink during discovery",
  async (target) => {
    const base = await fs.mkdtemp(join(tmpdir(), "hubble-search-scope-race-"));
    const root = join(base, "vault");
    const scope = join(root, "tickets");
    const child = join(scope, "TODO");
    const outside = join(base, "outside");
    await fs.mkdir(child, { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(join(child, "note.md"), "match safe");
    await fs.writeFile(join(outside, "private.md"), "match private");
    let replaced = false;
    const replace = async (path: string) => {
      replaced = true;
      await fs.rename(path, join(root, "original"));
      await fs.symlink(outside, path);
    };
    try {
      const opened = await Vault.open(root, {
        ...fs,
        async stat(path) {
          const metadata = await fs.stat(path);

          if (!replaced && target === "scope" && path.endsWith("/tickets")) {
            await replace(scope);
          }

          return metadata;
        },
        async readdir(path, options) {
          const entries = await fs.readdir(path, options);

          if (!replaced && target === "child" && path.endsWith("/tickets")) {
            await replace(child);
          }

          return entries;
        },
      });

      if (opened.status === "error") throw opened.error;

      expect(await opened.value.searchPage("match", { folder: "tickets", offset: 1, limit: 1 })).toMatchObject({
        status: "error",
        error: { _tag: "VaultDiscoveryError", reason: "unsafe-path" },
      });
      expect(await fs.readFile(join(outside, "private.md"), "utf8")).toBe("match private");
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }
);
