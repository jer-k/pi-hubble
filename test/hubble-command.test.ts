import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { registerHubbleCommand } from "../extensions/hubble-command.ts";
import { openVault } from "../extensions/hubble-vault.ts";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;
type CommandOptions = { getArgumentCompletions?: (prefix: string) => unknown; handler: CommandHandler };

function createPi() {
  let command: { options: CommandOptions } | undefined;
  const pi = { registerCommand(_name: string, options: CommandOptions) { command = { options }; } };
  return { pi: pi as unknown as ExtensionAPI, getCommand: () => command };
}

function createContext(overrides: Record<string, unknown> = {}) {
  const notifications: string[] = [];
  let editorText = "existing";
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    isProjectTrusted: () => true,
    isIdle: () => true,
    ui: {
      getEditorText: () => editorText,
      setEditorText: (text: string) => { editorText = text; },
      notify: (message: string) => notifications.push(message),
      custom: async (factory: (...args: unknown[]) => unknown) => {
        let selected: unknown;
        const component = factory({}, {}, {}, (value: unknown) => { selected = value; });
        void component;
        return selected;
      },
      input: async () => undefined,
    },
    ...overrides,
  };
  return { ctx, notifications, getEditorText: () => editorText };
}

async function getVault(root: string) {
  return openVault(root);
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

  const selected = { absolute: notePath, relative: "notes/one.md" };
  const interactive = createContext();
  interactive.ctx.ui.custom = async () => selected;
  await command?.options.handler("find one", interactive.ctx);
  expect(interactive.getEditorText()).toBe(`existing @${notePath}`);
  expect(interactive.notifications).toEqual([`Attached Hubble note: ${selected.relative}`]);

  const noUi = createContext({ hasUI: false });
  await command?.options.handler("", noUi.ctx);
  expect(noUi.notifications).toEqual(["/hubble requires interactive UI mode."]);
});

test("creates a titled note and handles an empty vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-command-new-"));
  const { pi, getCommand } = createPi();
  registerHubbleCommand(pi, () => getVault(root));
  const command = getCommand();
  const ctx = createContext();
  await command?.options.handler("new New note --folder=work", ctx.ctx);
  expect(ctx.notifications[0]).toBe("Created Hubble note: work/new-note.md");
  expect(ctx.getEditorText()).toContain(`@${join(await realpath(root), "work", "new-note.md")}`);

  const emptyRoot = await mkdtemp(join(tmpdir(), "pi-hubble-command-empty-"));
  const empty = createContext();
  empty.ctx.ui.custom = async () => undefined;
  registerHubbleCommand(pi, () => getVault(emptyRoot));
  const secondCommand = getCommand();
  await secondCommand?.options.handler("find", empty.ctx);
  expect(empty.notifications).toEqual(["The Hubble vault has no Markdown notes."]);
});
