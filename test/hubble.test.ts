import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  appendToVaultFile,
  applyExactEdits,
  assertMarkdownPath,
  createVault,
  editVaultFile,
  resolveVaultPath,
  writeNewVaultFile,
} from "../extensions/hubble-vault.ts";

test("keeps paths inside the vault and rejects symlink escapes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-hubble-test-"));
  const root = join(parent, "vault");
  const outside = join(parent, "outside.md");
  await writeFile(outside, "outside", "utf8");
  const vault = await createVault(root);
  const note = await writeNewVaultFile(vault, "My Note", "body");

  expect(note.relative).toBe("my-note.md");
  expect((await resolveVaultPath(vault, "my-note.md")).relative).toBe("my-note.md");
  await expect(resolveVaultPath(vault, "../outside.md")).rejects.toThrow(/escapes the vault/);

  await symlink(outside, join(root, "escape.md"));
  await expect(resolveVaultPath(vault, "escape.md")).rejects.toThrow(/escapes the vault/);
});

test("creates unique Markdown filenames and preserves edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-test-"));
  const vault = await createVault(root);
  const first = await writeNewVaultFile(vault, "Same Title", "first");
  const second = await writeNewVaultFile(vault, "Same Title", "second");

  expect(first.relative).toBe("same-title.md");
  expect(second.relative).toBe("same-title-2.md");

  const path = await resolveVaultPath(vault, first.relative);
  assertMarkdownPath(path);
  await appendToVaultFile(path, "appended");
  await editVaultFile(path, [{ oldText: "first", newText: "updated" }]);
  expect(await readFile(path.absolute, "utf8")).toBe("# Same Title\n\nupdated\nappended");
});

test("creates notes in optional folders and keeps folders inside the vault", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-hubble-test-"));
  const root = join(parent, "vault");
  const outside = join(parent, "outside");
  await mkdir(outside);
  const vault = await createVault(root);

  const note = await writeNewVaultFile(vault, "Nested Note", "body", "research/incident response");
  expect(note.relative).toBe("research/incident response/nested-note.md");
  expect(await readFile(note.absolute, "utf8")).toBe("# Nested Note\n\nbody");

  await expect(writeNewVaultFile(vault, "Escape", "", "../outside")).rejects.toThrow(/escapes the vault/);
  await symlink(outside, join(root, "external"));
  await expect(writeNewVaultFile(vault, "Escape", "", "external")).rejects.toThrow(
    /escapes the vault through a symlink/
  );
});

test("requires unique, non-overlapping exact edits", () => {
  expect(applyExactEdits("one two one", [{ oldText: "two", newText: "TWO" }], "note.md")).toBe("one TWO one");
  expect(() => applyExactEdits("one one", [{ oldText: "one", newText: "ONE" }], "note.md")).toThrow(/not unique/);
  expect(() =>
    applyExactEdits(
      "abcdef",
      [
        { oldText: "abc", newText: "A" },
        { oldText: "cde", newText: "B" },
      ],
      "note.md"
    )
  ).toThrow(/overlap/);
});
