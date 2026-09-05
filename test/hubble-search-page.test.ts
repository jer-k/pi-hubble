import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { Vault } from "../extensions/hubble-vault.ts";

test("stops reading after page lookahead and preserves unbounded search behavior", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "hubble-page-"));
  try {
    await fs.writeFile(join(root, "a.md"), "match 1\nmatch 2\nmatch 3\nmatch 4");
    await fs.writeFile(join(root, "z.md"), "match 5");
    const cause = new Error("later file unavailable");
    const opened = await Vault.open(root, {
      ...fs,
      async readFile(path, encoding) {
        if (path.endsWith("z.md")) throw cause;
        return fs.readFile(path, encoding);
      },
    });
    if (opened.status === "error") throw opened.error;
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
