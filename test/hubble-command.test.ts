import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Result } from "better-result";
import { expect, test } from "vitest";
import { parseHubbleCommand, parseNewCommand, registerHubbleCommand } from "../extensions/hubble-command.ts";
import { listMarkdownFiles } from "../extensions/hubble-vault.ts";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

type CommandOptions = { getArgumentCompletions?: (prefix: string) => unknown; handler: CommandHandler };

function createPi() {
  let command: { options: CommandOptions } | undefined;
  const pi = {
    registerCommand(_name: string, options: CommandOptions) {
      command = { options };
    },
  };
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
      setEditorText: (text: string) => {
        editorText = text;
      },
      notify: (message: string) => notifications.push(message),
      custom: async (factory: (...args: unknown[]) => unknown) => {
        let selected: unknown;
        const component = factory({}, {}, {}, (value: unknown) => {
          selected = value;
        });
        void component;
        selected = selected ?? undefined;
        return selected;
      },
      input: async () => undefined,
    },
    ...overrides,
  };
  return { ctx, notifications, getEditorText: () => editorText };
}

test("parses browse, content-search, and new command arguments", () => {
  expect(parseHubbleCommand("  search  Incident Response ")).toEqual({
    query: "Incident Response",
    searchContents: true,
  });
  expect(parseHubbleCommand("OPEN project")).toEqual({ query: "project", searchContents: false });
  expect(parseHubbleCommand(" filename ")).toEqual({ query: "filename", searchContents: false });
  expect(parseNewCommand("new \"Meeting notes\" --folder='team notes'")).toEqual({
    title: "Meeting notes",
    folder: "team notes",
  });
  expect(parseNewCommand("new title --folder=research")).toEqual({ title: "title", folder: "research" });
  expect(parseNewCommand("new title")).toEqual({ title: "title", folder: undefined });
  expect(parseNewCommand("search title")).toBeUndefined();
});

test("registers the command and attaches a selected note", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-command-"));
  await mkdir(join(root, "notes"));
  const notePath = join(root, "notes", "one.md");
  await writeFile(notePath, "# One", "utf8");
  const { pi, getCommand } = createPi();
  const getRoot = async () => Result.ok(root);
  registerHubbleCommand(pi, getRoot);
  const command = getCommand();
  expect(command).toBeDefined();
  expect(await command?.options.getArgumentCompletions?.("se")).toEqual([
    { value: "search", label: "search", description: "Search note contents" },
  ]);

  const selected = { absolute: notePath, relative: "notes/one.md" };
  const interactive = createContext();
  interactive.ctx.ui.custom = async () => selected;
  await command?.options.handler("open", interactive.ctx);
  expect(interactive.getEditorText()).toBe(`existing @${notePath}`);
  expect(interactive.notifications).toEqual([`Attached Hubble note: ${selected.relative}`]);

  const noUi = createContext({ hasUI: false });
  await command?.options.handler("", noUi.ctx);
  expect(noUi.notifications).toEqual(["/hubble requires interactive UI mode."]);

  const files = await listMarkdownFiles({ root });
  expect(files.status).toBe("ok");
});

test("creates a titled note and handles an empty vault", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hubble-command-new-"));
  const { pi, getCommand } = createPi();
  registerHubbleCommand(pi, async () => Result.ok(root));
  const command = getCommand();
  const ctx = createContext();
  await command?.options.handler("new New note --folder=work", ctx.ctx);
  expect(ctx.notifications[0]).toBe("Created Hubble note: work/new-note.md");
  expect(ctx.getEditorText()).toContain(`@${join(await realpath(root), "work", "new-note.md")}`);

  const emptyRoot = await mkdtemp(join(tmpdir(), "pi-hubble-command-empty-"));
  const empty = createContext();
  empty.ctx.ui.custom = async () => undefined;
  registerHubbleCommand(pi, async () => Result.ok(emptyRoot));
  const secondCommand = getCommand();
  await secondCommand?.options.handler("open", empty.ctx);
  expect(empty.notifications).toEqual(["The Hubble vault has no Markdown notes."]);
});
