import { chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Result } from "better-result";
import { expect, test } from "vitest";

import { resolveHubbleRoot } from "../extensions/hubble-config.ts";
import { openVault } from "../extensions/hubble-vault.ts";

async function vaultAt(root: string) {
  const result = await openVault(root);
  if (Result.isError(result)) throw result.error;
  return result.value;
}

test("handles missing roots and returns structured note failures", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-hubble-vault-"));
  const vault = await vaultAt(join(parent, "missing-vault"));

  expect(await vault.list()).toEqual({ status: "ok", value: [] });
  for (const result of [
    await vault.read("missing.md"),
    await vault.edit("missing.md", [{ oldText: "old", newText: "new" }]),
  ]) {
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error._tag).toBe("NoteNotFoundError");
  }

  const created = await vault.create("First Note", "Alpha\nIncident response");
  expect(created.status).toBe("ok");
  if (created.status === "ok") {
    expect(created.value.relative).toBe("first-note.md");
    expect(await readFile(created.value.absolute, "utf8")).toBe("# First Note\n\nAlpha\nIncident response");
  }
});

test("keeps Vault operations inside the root and protects symlinks", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-hubble-vault-"));
  const root = join(parent, "vault");
  const outside = join(parent, "outside.md");
  const outsideHtml = join(parent, "outside.html");
  await writeFile(outside, "outside", "utf8");
  await writeFile(outsideHtml, "<p>outside</p>", "utf8");
  const vault = await vaultAt(root);
  const note = await vault.create("My Note", "body");
  if (note.status === "error") throw note.error;

  const traversal = await vault.read("../outside.md");
  expect(traversal.status).toBe("error");
  expect((await vault.read("../outside.html")).status).toBe("error");
  await symlink(outside, join(root, "escape.md"));
  const symlinkEscape = await vault.read("escape.md");
  expect(symlinkEscape.status).toBe("error");
  if (symlinkEscape.status === "error") expect(symlinkEscape.error._tag).toBe("VaultPathError");

  await symlink(outsideHtml, join(root, "escape.html"));
  const htmlSymlinkEscape = await vault.read("escape.html");
  expect(htmlSymlinkEscape.status).toBe("error");
  if (htmlSymlinkEscape.status === "error") expect(htmlSymlinkEscape.error._tag).toBe("VaultPathError");

  const createThroughSymlink = await vault.create("Safe Title", "changed", "", undefined, "escape.md");
  expect(createThroughSymlink.status).toBe("error");
  expect(await readFile(outside, "utf8")).toBe("outside");
});

test("atomically edits the canonical target of a symlink that stays inside the vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-internal-symlink-"));
  const target = join(root, "target.md");
  const alias = join(root, "alias.md");
  await writeFile(target, "old", "utf8");
  await symlink(target, alias);
  const vault = await vaultAt(root);

  const edited = await vault.edit("alias.md", [{ oldText: "old", newText: "new" }]);

  expect(edited.status).toBe("ok");
  if (edited.status === "ok") expect(edited.value.relative).toBe("target.md");
  expect(await readFile(target, "utf8")).toBe("new");
  expect((await lstat(alias)).isSymbolicLink()).toBe(true);
});

test("rejects a missing vault root replaced by a symlink before creation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-hubble-root-symlink-"));
  const root = join(parent, "vault");
  const outside = join(parent, "outside");
  await mkdir(outside);
  const vault = await vaultAt(root);

  await symlink(outside, root, "dir");
  const created = await vault.create("Escaped Note", "outside");

  expect(created.status).toBe("error");
  if (created.status === "error") {
    expect(created.error._tag).toBe("VaultPathError");
    if (created.error._tag === "VaultPathError") expect(created.error.reason).toBe("symlink-escape");
  }
  await expect(readFile(join(outside, "escaped-note.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("supports structured search and serialized exact mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-vault-"));
  const vault = await vaultAt(root);
  const first = await vault.create("Same Title", "first\nIncident response");
  const second = await vault.create("Same Title", "second");
  if (first.status === "error" || second.status === "error") throw new Error("create failed");
  expect(second.value.relative).toBe("same-title-2.md");

  const search = await vault.search("INCIDENT");
  expect(search).toEqual({
    status: "ok",
    value: [{ note: first.value, matches: [{ line: 4, text: "Incident response" }] }],
  });
  const read = await vault.read(first.value.relative);
  expect(read.status).toBe("ok");
  const [firstEdit, secondEdit] = await Promise.all([
    vault.edit(first.value.relative, [{ oldText: "first", newText: "updated" }]),
    vault.edit(first.value.relative, [{ oldText: "Incident response", newText: "Resolved incident" }]),
  ]);
  expect(firstEdit.status).toBe("ok");
  expect(secondEdit.status).toBe("ok");
  expect(await readFile(first.value.absolute, "utf8")).toBe("# Same Title\n\nupdated\nResolved incident");

  const invalid = await vault.edit(first.value.relative, [{ oldText: "same", newText: "same" }]);
  expect(invalid.status).toBe("error");
});

test("uses exact optional filenames independently from titles and rejects unsafe or conflicting names", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-exact-filename-"));
  const vault = await vaultAt(root);

  const markdown = await vault.create("Jerms Is Testing", "body", "checks", undefined, "jerms-test.md");
  expect(markdown.status).toBe("ok");
  if (markdown.status === "ok") {
    expect(markdown.value.relative).toBe("checks/jerms-test.md");
    expect(await readFile(markdown.value.absolute, "utf8")).toBe("# Jerms Is Testing\n\nbody");
  }

  const html = await vault.create("Exact HTML", "<p>body</p>", "", undefined, "custom-page.HTML");
  expect(html.status).toBe("ok");
  if (html.status === "ok") {
    expect(html.value.relative).toBe("custom-page.HTML");
    expect(await readFile(html.value.absolute, "utf8")).toContain("<title>Exact HTML</title>");
  }

  const collision = await vault.create("Another Title", "replacement", "checks", undefined, "jerms-test.md");
  expect(collision.status).toBe("error");
  if (collision.status === "error") {
    expect(collision.error._tag).toBe("NoteWriteError");
    if (collision.error._tag === "NoteWriteError") {
      expect(collision.error.path).toBe("checks/jerms-test.md");
      expect(collision.error.cause).toMatchObject({ _tag: "ExistingFileError" });
    }
  }
  await expect(readFile(join(root, "checks", "jerms-test-2.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  for (const filename of ["../escape.md", "nested/escape.md", "nested\\escape.md", "/absolute.md", "note.txt"]) {
    const invalid = await vault.create("Invalid", "", "", undefined, filename);
    expect(invalid.status).toBe("error");
    if (invalid.status === "error") {
      expect(invalid.error._tag).toBe("NoteValidationError");
      if (invalid.error._tag === "NoteValidationError") expect(invalid.error.reason).toBe("filename");
    }
  }

  const mismatch = await vault.create("Mismatch", "", "", "html", "mismatch.md");
  expect(mismatch.status).toBe("error");
  if (mismatch.status === "error") {
    expect(mismatch.error._tag).toBe("NoteValidationError");
    if (mismatch.error._tag === "NoteValidationError") expect(mismatch.error.reason).toBe("format");
  }
});

test("serializes concurrent creation attempts for an exact filename without overwriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-exact-filename-concurrent-"));
  const vault = await vaultAt(root);

  const results = await Promise.all([
    vault.create("First", "first", "", undefined, "shared.md"),
    vault.create("Second", "second", "", undefined, "shared.md"),
  ]);

  expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
  const failure = results.find((result) => result.status === "error");
  expect(failure?.status).toBe("error");
  if (failure?.status === "error" && failure.error._tag === "NoteWriteError") {
    expect(failure.error.cause).toMatchObject({ _tag: "ExistingFileError" });
  }
  expect(["# First\n\nfirst", "# Second\n\nsecond"]).toContain(await readFile(join(root, "shared.md"), "utf8"));
});

test("preserves a note's BOM, CRLF line endings, and permissions while editing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-edit-format-"));
  const path = join(root, "formatted.md");
  await writeFile(path, "\uFEFF# Formatted\r\n\r\nAlpha\r\nBeta\r\n", "utf8");
  await chmod(path, 0o640);
  const vault = await vaultAt(root);

  const edited = await vault.edit("formatted.md", [{ oldText: "Alpha\nBeta", newText: "Updated\nContent" }]);

  expect(edited.status).toBe("ok");
  expect(await readFile(path, "utf8")).toBe("\uFEFF# Formatted\r\n\r\nUpdated\r\nContent\r\n");
  expect((await stat(path)).mode & 0o777).toBe(0o640);
});

test("rejects overlapping duplicate exact edit matches without changing the note", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-overlapping-edit-"));
  const path = join(root, "overlapping.md");
  await writeFile(path, "aaa", "utf8");
  const vault = await vaultAt(root);

  const edited = await vault.edit("overlapping.md", [{ oldText: "aa", newText: "X" }]);

  expect(edited.status).toBe("error");
  if (edited.status === "error") {
    expect(edited.error._tag).toBe("EditValidationError");
    if (edited.error._tag === "EditValidationError") expect(edited.error.reason).toBe("duplicate");
  }
  expect(await readFile(path, "utf8")).toBe("aaa");
});

test("discovers, reads, searches, and edits Markdown and HTML notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-html-vault-"));
  await writeFile(join(root, "alpha.md"), "# Alpha\n\nMarkdown match", "utf8");
  await writeFile(join(root, "page.HTML"), "<main>HTML match</main>", "utf8");
  await writeFile(join(root, "upper.MD"), "# Upper", "utf8");
  await writeFile(join(root, "ignored.txt"), "ignored match", "utf8");
  const vault = await vaultAt(root);

  const listed = await vault.list();
  expect(listed.status).toBe("ok");
  if (listed.status === "ok") {
    expect(listed.value.map((note) => note.relative)).toEqual(["alpha.md", "page.HTML", "upper.MD"]);
  }

  const read = await vault.read("page.HTML");
  expect(read.status).toBe("ok");
  if (read.status === "ok") expect(read.value.content).toBe("<main>HTML match</main>");

  const search = await vault.search("match");
  expect(search.status).toBe("ok");
  if (search.status === "ok")
    expect(search.value.map((result) => result.note.relative)).toEqual(["alpha.md", "page.HTML"]);

  const edited = await vault.edit("page.HTML", [{ oldText: "HTML match", newText: "updated source" }]);
  expect(edited.status).toBe("ok");
  expect(await readFile(join(root, "page.HTML"), "utf8")).toBe("<main>updated source</main>");

  const unsupported = await vault.read("ignored.txt");
  expect(unsupported.status).toBe("error");
  if (unsupported.status === "error") {
    expect(unsupported.error._tag).toBe("VaultPathError");
    if (unsupported.error._tag === "VaultPathError") expect(unsupported.error.reason).toBe("unsupported-note-format");
  }
});

test("creates standalone HTML notes with escaped titles and format-specific collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-html-create-"));
  const vault = await vaultAt(root);
  const title = '<A & "B">';
  const first = await vault.create(title, "<p>Alpha & beta</p>", "web/pages", "html");
  const second = await vault.create(title, "<p>Second</p>", "web/pages", "html");
  const markdown = await vault.create(title, "default", "web/pages");
  if (first.status === "error" || second.status === "error" || markdown.status === "error") {
    throw new Error("create failed");
  }

  expect(first.value.relative).toBe("web/pages/a-and-b.html");
  expect(second.value.relative).toBe("web/pages/a-and-b-2.html");
  expect(markdown.value.relative).toBe("web/pages/a-and-b.md");
  expect(await readFile(first.value.absolute, "utf8")).toBe(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>&lt;A &amp; &quot;B&quot;&gt;</title>
</head>
<body>
  <h1>&lt;A &amp; &quot;B&quot;&gt;</h1>
<p>Alpha & beta</p>
</body>
</html>`);
  expect(await readFile(markdown.value.absolute, "utf8")).toBe(`# ${title}\n\ndefault`);
});

test("creates notes in optional folders and rejects invalid edits", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-hubble-vault-"));
  const outside = join(parent, "outside");
  await mkdir(outside);
  const vault = await vaultAt(join(parent, "vault"));
  const nested = await vault.create("Nested Note", "body", "research/incident response");
  expect(nested.status).toBe("ok");
  if (nested.status === "ok") expect(nested.value.relative).toBe("research/incident response/nested-note.md");

  const traversal = await vault.create("Escape", "", "../outside");
  expect(traversal.status).toBe("error");
  await symlink(outside, join(vault.root, "external"));
  const symlinkEscape = await vault.create("Escape", "", "external");
  expect(symlinkEscape.status).toBe("error");
});

test("uses local config over global config and the CLI as an escape hatch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-hubble-config-test-"));
  const originalCwd = process.cwd();
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.chdir(workspace);
    process.env.PI_CODING_AGENT_DIR = join(workspace, "global");
    await mkdir(join(workspace, ".pi"), { recursive: true });
    await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    await writeFile(join(workspace, "global", "hubble.json"), '{"root":"global-vault"}', "utf8");
    await writeFile(join(workspace, ".pi", "hubble.json"), '{"root":"local-vault"}', "utf8");
    const local = await resolveHubbleRoot(undefined);
    expect(local.status).toBe("ok");
    if (local.status === "ok") expect(local.value).toBe(resolve(process.cwd(), "local-vault"));
    const cli = await resolveHubbleRoot("cli-vault");
    expect(cli.status).toBe("ok");
    if (cli.status === "ok") expect(cli.value).toBe(resolve(process.cwd(), "cli-vault"));
  } finally {
    process.chdir(originalCwd);
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

test("ignores untrusted local config and requires configuration", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-hubble-config-test-"));
  const global = join(workspace, "global");
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(global, { recursive: true });
    await mkdir(join(workspace, ".pi"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = global;
    await writeFile(join(global, "hubble.json"), '{"root":"global-vault"}', "utf8");
    await writeFile(join(workspace, ".pi", "hubble.json"), "{bad", "utf8");
    const untrusted = await resolveHubbleRoot(undefined, workspace, false);
    expect(untrusted.status).toBe("ok");
    const trusted = await resolveHubbleRoot(undefined, workspace, true);
    expect(trusted.status).toBe("error");
    if (trusted.status === "error") expect(trusted.error._tag).toBe("ConfigParseError");

    process.env.PI_CODING_AGENT_DIR = join(workspace, "missing-global");
    const missing = await resolveHubbleRoot(undefined, workspace, false);
    expect(missing.status).toBe("error");
    if (missing.status === "error") expect(missing.error._tag).toBe("VaultNotConfiguredError");
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});
