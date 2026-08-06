import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyExactEdits,
  appendToVaultFile,
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

  assert.equal(note.relative, "my-note.md");
  assert.equal((await resolveVaultPath(vault, "my-note.md")).relative, "my-note.md");
  await assert.rejects(() => resolveVaultPath(vault, "../outside.md"), /escapes the vault/);

  await symlink(outside, join(root, "escape.md"));
  await assert.rejects(() => resolveVaultPath(vault, "escape.md"), /escapes the vault/);
});

test("creates unique Markdown filenames and preserves edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-test-"));
  const vault = await createVault(root);
  const first = await writeNewVaultFile(vault, "Same Title", "first");
  const second = await writeNewVaultFile(vault, "Same Title", "second");

  assert.equal(first.relative, "same-title.md");
  assert.equal(second.relative, "same-title-2.md");

  const path = await resolveVaultPath(vault, first.relative);
  assertMarkdownPath(path);
  await appendToVaultFile(path, "appended");
  await editVaultFile(path, [{ oldText: "first", newText: "updated" }]);
  assert.equal(await readFile(path.absolute, "utf8"), "# Same Title\n\nupdated\nappended");
});

test("creates notes in optional folders and keeps folders inside the vault", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-hubble-test-"));
  const root = join(parent, "vault");
  const outside = join(parent, "outside");
  await mkdir(outside);
  const vault = await createVault(root);

  const note = await writeNewVaultFile(vault, "Nested Note", "body", "research/incident response");
  assert.equal(note.relative, "research/incident response/nested-note.md");
  assert.equal(await readFile(note.absolute, "utf8"), "# Nested Note\n\nbody");

  await assert.rejects(
    () => writeNewVaultFile(vault, "Escape", "", "../outside"),
    /escapes the vault/,
  );
  await symlink(outside, join(root, "external"));
  await assert.rejects(
    () => writeNewVaultFile(vault, "Escape", "", "external"),
    /escapes the vault through a symlink/,
  );
});

test("requires unique, non-overlapping exact edits", () => {
  assert.equal(applyExactEdits("one two one", [{ oldText: "two", newText: "TWO" }]), "one TWO one");
  assert.throws(
    () => applyExactEdits("one one", [{ oldText: "one", newText: "ONE" }], "note.md"),
    /not unique/,
  );
  assert.throws(
    () => applyExactEdits("abcdef", [
      { oldText: "abc", newText: "A" },
      { oldText: "cde", newText: "B" },
    ], "note.md"),
    /overlap/,
  );
});
