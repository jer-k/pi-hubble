import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { throwCreateToolError } from "../extensions/hubble.ts";
import { resolveHubbleRoot } from "../extensions/hubble-config.ts";
import {
  appendToVaultFile,
  applyExactEdits,
  applyExactEditsResult,
  assertMarkdownPath,
  createVault as createVaultResult,
  editVaultFile,
  type HubblePath,
  listMarkdownFiles,
  readVaultFile,
  resolveVaultPath,
  truncateOutput,
  writeNewVaultFile,
} from "../extensions/hubble-vault.ts";

async function createVault(root: string) {
  const result = await createVaultResult(root);
  if (result.status === "error") throw result.error;
  return result.value;
}

async function resolvePath(...args: Parameters<typeof resolveVaultPath>): Promise<HubblePath> {
  const result = await resolveVaultPath(...args);
  if (result.status === "error") throw result.error;
  return result.value;
}

async function createNote(...args: Parameters<typeof writeNewVaultFile>): Promise<HubblePath> {
  const result = await writeNewVaultFile(...args);
  if (result.status === "error") throw result.error;
  return result.value;
}

test("keeps paths inside the vault and rejects symlink escapes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-hubble-test-"));
  const root = join(parent, "vault");
  const outside = join(parent, "outside.md");
  await writeFile(outside, "outside", "utf8");
  const vault = await createVault(root);
  const note = await createNote(vault, "My Note", "body");

  expect(note.relative).toBe("my-note.md");
  expect((await resolvePath(vault, "my-note.md")).relative).toBe("my-note.md");
  const traversal = await resolveVaultPath(vault, "../outside.md");
  expect(traversal.status).toBe("error");

  await symlink(outside, join(root, "escape.md"));
  const symlinkEscape = await resolveVaultPath(vault, "escape.md");
  expect(symlinkEscape.status).toBe("error");
});

test("creates unique Markdown filenames and preserves edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-test-"));
  const vault = await createVault(root);
  const first = await createNote(vault, "Same Title", "first");
  const second = await createNote(vault, "Same Title", "second");

  expect(first.relative).toBe("same-title.md");
  expect(second.relative).toBe("same-title-2.md");

  const path = await resolvePath(vault, first.relative);
  const markdown = assertMarkdownPath(path);
  if (markdown.status === "error") throw markdown.error;
  const appended = await appendToVaultFile(path, "appended");
  if (appended.status === "error") throw appended.error;
  const edited = await editVaultFile(path, [{ oldText: "first", newText: "updated" }]);
  if (edited.status === "error") throw edited.error;
  expect(await readFile(path.absolute, "utf8")).toBe("# Same Title\n\nupdated\nappended");
});

test("returns typed create failures and the tool adapter throws safe errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-test-"));
  const vault = await createVault(root);

  const emptyTitle = await writeNewVaultFile(vault, "   ", "body");
  expect(emptyTitle.status).toBe("error");
  if (emptyTitle.status === "error") {
    expect(emptyTitle.error._tag).toBe("NoteTitleError");
    expect(() => throwCreateToolError(emptyTitle.error)).toThrow("title must not be empty");
  }

  await writeFile(join(root, "not-a-folder"), "file", "utf8");
  const invalidFolder = await writeNewVaultFile(vault, "Note", "body", "not-a-folder");
  expect(invalidFolder.status).toBe("error");
  if (invalidFolder.status === "error" && invalidFolder.error._tag === "VaultPathError") {
    expect(invalidFolder.error.reason).toBe("not-directory");
  }

  const rootFile = join(root, "root-file");
  await writeFile(rootFile, "file", "utf8");
  const writeFailure = await writeNewVaultFile({ root: rootFile }, "Note", "body");
  expect(writeFailure.status).toBe("error");
  if (writeFailure.status === "error") {
    expect(writeFailure.error._tag).toBe("NoteWriteError");
  }
});

test("creates notes in optional folders and keeps folders inside the vault", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-hubble-test-"));
  const root = join(parent, "vault");
  const outside = join(parent, "outside");
  await mkdir(outside);
  const vault = await createVault(root);

  const note = await createNote(vault, "Nested Note", "body", "research/incident response");
  expect(note.relative).toBe("research/incident response/nested-note.md");
  expect(await readFile(note.absolute, "utf8")).toBe("# Nested Note\n\nbody");

  const traversal = await writeNewVaultFile(vault, "Escape", "", "../outside");
  expect(traversal.status).toBe("error");
  if (traversal.status === "error") expect(traversal.error.message).toMatch(/escapes the vault/);
  await symlink(outside, join(root, "external"));
  const symlinkEscape = await writeNewVaultFile(vault, "Escape", "", "external");
  expect(symlinkEscape.status).toBe("error");
  if (symlinkEscape.status === "error") {
    expect(symlinkEscape.error.message).toMatch(/escapes the vault through a symlink/);
  }
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

test("classifies exact-edit validation without swallowing defects", () => {
  const cases = [
    { edits: [], reason: "empty", content: "one" },
    { edits: [{ oldText: "", newText: "new" }], reason: "empty", content: "one" },
    { edits: [{ oldText: "missing", newText: "new" }], reason: "missing", content: "one" },
    { edits: [{ oldText: "one", newText: "new" }], reason: "duplicate", content: "one one" },
    {
      edits: [
        { oldText: "abc", newText: "A" },
        { oldText: "cde", newText: "B" },
      ],
      reason: "overlap",
      content: "abcdef",
    },
    { edits: [{ oldText: "same", newText: "same" }], reason: "no-op", content: "same" },
  ] as const;

  for (const testCase of cases) {
    const result = applyExactEditsResult(testCase.content, [...testCase.edits], "note.md");
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.reason).toBe(testCase.reason);
  }

  const malformed = [undefined] as unknown as Parameters<typeof applyExactEditsResult>[1];
  expect(() => applyExactEditsResult("content", malformed, "note.md")).toThrow(TypeError);
});

test("returns typed read, edit, append, discovery, and truncation failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-test-"));
  const vault = await createVault(root);
  const missing = await resolvePath(vault, "missing.md");

  const read = await readVaultFile(missing);
  expect(read.status).toBe("error");
  if (read.status === "error") expect(read.error._tag).toBe("NoteNotFoundError");

  const append = await appendToVaultFile(missing, "");
  expect(append.status).toBe("error");
  if (append.status === "error") expect(append.error._tag).toBe("NoteAppendValidationError");

  const edit = await editVaultFile(missing, [{ oldText: "old", newText: "new" }]);
  expect(edit.status).toBe("error");
  if (edit.status === "error") expect(edit.error._tag).toBe("NoteNotFoundError");

  const invalidEdit = applyExactEditsResult("same", [{ oldText: "same", newText: "same" }], "note.md");
  expect(invalidEdit.status).toBe("error");
  if (invalidEdit.status === "error") expect(invalidEdit.error.reason).toBe("no-op");

  const missingVault = await listMarkdownFiles({ root: join(root, "missing-vault") });
  expect(missingVault).toEqual({ status: "ok", value: [] });

  const truncated = await truncateOutput(`${"line\n".repeat(3000)}`);
  expect(truncated.status).toBe("ok");
  if (truncated.status === "ok") {
    expect(truncated.value.truncated).toBe(true);
    expect(truncated.value.fullOutputPath).toBeDefined();
  }
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

test("ignores untrusted local config and classifies malformed config", async () => {
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
    if (untrusted.status === "ok") expect(untrusted.value).toBe(resolve(workspace, "global-vault"));

    const trusted = await resolveHubbleRoot(undefined, workspace, true);
    expect(trusted.status).toBe("error");
    if (trusted.status === "error") expect(trusted.error._tag).toBe("ConfigParseError");
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

test("requires a configured vault when no override is provided", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-hubble-config-test-"));
  const originalCwd = process.cwd();
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.chdir(workspace);
    process.env.PI_CODING_AGENT_DIR = join(workspace, "missing-global");
    const result = await resolveHubbleRoot(undefined);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error._tag).toBe("VaultNotConfiguredError");
  } finally {
    process.chdir(originalCwd);
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});
