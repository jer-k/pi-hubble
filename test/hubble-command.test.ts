import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import { registerHubbleCommand } from "../extensions/hubble-command.ts";
import { type NoteReference, openVault } from "../extensions/hubble-vault.ts";
import { testCast } from "./test-cast.ts";

type RegisteredCommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
type CommandOptions = Pick<RegisteredCommandOptions, "getArgumentCompletions"> & { handler: CommandHandler };

function createPi() {
  let command: { options: CommandOptions } | undefined;
  const sentMessages: string[] = [];
  const pi = {
    registerCommand(_name: string, options: CommandOptions) {
      command = { options };
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
  };
  return { pi: testCast<typeof pi, ExtensionAPI>(pi), getCommand: () => command, sentMessages };
}

type TestContextOptions = {
  readonly hasUI?: boolean;
};

function createContext(options: TestContextOptions = {}) {
  const notifications: string[] = [];
  let editorText = "existing";
  const ctx = {
    cwd: process.cwd(),
    hasUI: options.hasUI ?? true,
    isProjectTrusted: () => true,
    isIdle: () => true,
    ui: {
      getEditorText: () => editorText,
      setEditorText: (text: string) => {
        editorText = text;
      },
      notify: (message: string) => notifications.push(message),
      custom: async (): Promise<NoteReference | undefined> => undefined,
      input: async (): Promise<string | undefined> => undefined,
    },
  };
  return { ctx, notifications, getEditorText: () => editorText };
}

async function getVault(root: string) {
  return openVault(root);
}

/** Invokes a registered command with the focused context fake used by these tests. */
async function runCommand(
  command: CommandOptions | undefined,
  args: string,
  ctx: ReturnType<typeof createContext>["ctx"]
) {
  await command?.handler(args, testCast<typeof ctx, ExtensionCommandContext>(ctx));
}

test("registers find/search behavior and attaches a selected note", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-command-"));
  await mkdir(join(root, "notes"));
  const notePath = join(root, "notes", "one.md");
  await writeFile(notePath, "# One", "utf8");
  const { pi, getCommand } = createPi();
  registerHubbleCommand(pi, () => getVault(root));
  const command = getCommand();
  expect(command).toBeDefined();
  expect(await command?.options.getArgumentCompletions?.("se")).toEqual([
    { value: "search", label: "search", description: "Search note contents" },
  ]);

  const opened = await openVault(root);
  if (opened.status === "error") throw opened.error;
  const listed = await opened.value.list();
  if (listed.status === "error") throw listed.error;
  const selected = listed.value.find((note) => note.relative === "notes/one.md");
  if (selected === undefined) throw new Error("Expected the test note in the vault listing");
  const interactive = createContext();
  interactive.ctx.ui.custom = async () => selected;
  await runCommand(command?.options, "find one", interactive.ctx);
  expect(interactive.getEditorText()).toBe(`existing @${selected.absolute}`);
  expect(interactive.notifications).toEqual([`Attached Hubble note: ${selected.relative}`]);

  const noUi = createContext({ hasUI: false });
  await runCommand(command?.options, "", noUi.ctx);
  expect(noUi.notifications).toEqual(["/hubble requires interactive UI mode."]);
});

test("creates titled Markdown and HTML notes and handles an empty vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-command-new-"));
  const { pi, getCommand, sentMessages } = createPi();
  registerHubbleCommand(pi, () => getVault(root));
  const command = getCommand();
  const ctx = createContext();
  await runCommand(command?.options, "new New note --folder=work", ctx.ctx);
  expect(ctx.notifications[0]).toBe("Created Hubble note: work/new-note.md");
  expect(ctx.getEditorText()).toContain(`@${join(await realpath(root), "work", "new-note.md")}`);

  const html = createContext();
  await runCommand(command?.options, "new HTML page --folder=work --format html", html.ctx);
  expect(html.notifications[0]).toBe("Created Hubble note: work/html-page.html");
  expect(html.getEditorText()).toContain(`@${join(await realpath(root), "work", "html-page.html")}`);

  const assisted = createContext();
  assisted.ctx.ui.input = async () => "";
  await runCommand(command?.options, "new --format html --folder=work", assisted.ctx);
  expect(sentMessages).toHaveLength(1);
  expect(sentMessages[0]).toContain("HTML body fragment");
  expect(sentMessages[0]).toContain('format to "html"');

  const invalid = createContext();
  await runCommand(command?.options, "new Invalid --format pdf --folder=work", invalid.ctx);
  expect(invalid.notifications).toEqual(["Hubble note format must be 'markdown' or 'html'."]);

  const emptyRoot = await mkdtemp(join(tmpdir(), "pi-hubble-command-empty-"));
  const empty = createContext();
  empty.ctx.ui.custom = async () => undefined;
  registerHubbleCommand(pi, () => getVault(emptyRoot));
  const secondCommand = getCommand();
  await runCommand(secondCommand?.options, "find", empty.ctx);
  expect(empty.notifications).toEqual(["The Hubble vault has no notes."]);
});
