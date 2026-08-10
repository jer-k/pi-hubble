import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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
    await vault.append("missing.md", "content"),
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
  await writeFile(outside, "outside", "utf8");
  const vault = await vaultAt(root);
  const note = await vault.create("My Note", "body");
  if (note.status === "error") throw note.error;

  const traversal = await vault.read("../outside.md");
  expect(traversal.status).toBe("error");
  await symlink(outside, join(root, "escape.md"));
  const symlinkEscape = await vault.read("escape.md");
  expect(symlinkEscape.status).toBe("error");
  if (symlinkEscape.status === "error") expect(symlinkEscape.error._tag).toBe("VaultPathError");
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
  const edited = await vault.edit(first.value.relative, [{ oldText: "first", newText: "updated" }]);
  const appended = await vault.append(first.value.relative, "appended");
  expect(edited.status).toBe("ok");
  expect(appended.status).toBe("ok");
  expect(await readFile(first.value.absolute, "utf8")).toBe("# Same Title\n\nupdated\nIncident response\nappended");

  const invalid = await vault.edit(first.value.relative, [{ oldText: "same", newText: "same" }]);
  expect(invalid.status).toBe("error");
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
