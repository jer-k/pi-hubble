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
    await fs.symlink(outside, join(root, "external"), "dir");
    const opened = await Vault.open(root, {
      ...fs,
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
