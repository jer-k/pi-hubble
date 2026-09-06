import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { Vault } from "../extensions/hubble-vault.ts";

test.each(["root", "directory", "note"] as const)(
  "rejects a %s replaced by an external symlink during a session",
  async (target) => {
    const base = await fs.mkdtemp(join(tmpdir(), "hubble-discovery-safety-"));
    const root = join(base, "vault");
    const outside = join(base, "outside");
    await fs.mkdir(join(root, "folder"), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, "private.md"), "private");
    await fs.writeFile(join(root, "note.md"), "safe");
    let swapped = false;
    try {
      const opened = await Vault.open(root, {
        ...fs,
        async readdir(path, options) {
          const entries = await fs.readdir(path, options);

          if (!swapped && target !== "root") {
            swapped = true;
            const replacing = target === "directory" ? join(root, "folder") : join(root, "note.md");
            await fs.rm(replacing, { recursive: true });
            await fs.symlink(target === "directory" ? outside : join(outside, "private.md"), replacing);
          }

          return entries;
        },
      });

      if (opened.status === "error") {
        throw opened.error;
      }

      if (target === "root") {
        await fs.rename(root, join(base, "original"));
        await fs.symlink(outside, root);
      }

      expect(await opened.value.list()).toMatchObject({
        status: "error",
        error: { _tag: "VaultDiscoveryError", reason: "unsafe-path" },
      });
      expect(await fs.readFile(join(outside, "private.md"), "utf8")).toBe("private");
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }
);

test("discovers safe notes and ignores static symlinks", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "hubble-discovery-safe-"));
  try {
    await fs.writeFile(join(root, "safe.md"), "safe");
    await fs.symlink(join(root, "safe.md"), join(root, "alias.md"));
    const opened = await Vault.open(root);

    if (opened.status === "error") {
      throw opened.error;
    }

    const listed = await opened.value.list();
    expect(listed.status).toBe("ok");

    if (listed.status === "ok") {
      expect(listed.value.map((note) => note.relative)).toEqual(["safe.md"]);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
