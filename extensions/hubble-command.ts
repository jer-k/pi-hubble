import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, fuzzyFilter } from "@earendil-works/pi-tui";
import { Result, type Result as ResultType } from "better-result";
import { attachmentValue, errorMessage, type GetRoot, getVault, type HubbleError } from "./hubble-boundary.ts";
import { HubbleNotePicker } from "./hubble-ui.ts";
import {
  type HubblePath,
  type HubbleVault,
  listMarkdownFiles,
  readVaultFile,
  writeNewVaultFile,
} from "./hubble-vault.ts";

function appendEditorAttachment(
  ctx: { ui: { getEditorText(): string; setEditorText(text: string): void } },
  path: string
): void {
  const current = ctx.ui.getEditorText().trimEnd();
  ctx.ui.setEditorText(`${current}${current ? " " : ""}${attachmentValue(path)}`);
}

export function parseHubbleCommand(args: string): { query: string; searchContents: boolean } {
  const trimmed = args.trim();
  const searchMatch = trimmed.match(/^search(?:\s+(.+))?$/iu);
  if (searchMatch) return { query: searchMatch[1]?.trim() ?? "", searchContents: true };

  const openMatch = trimmed.match(/^open(?:\s+(.+))?$/iu);
  if (openMatch) return { query: openMatch[1]?.trim() ?? "", searchContents: false };

  return { query: trimmed, searchContents: false };
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseNewCommand(args: string): { title: string; folder?: string } | undefined {
  const match = args.trim().match(/^new(?:\s+([\s\S]*))?$/iu);
  if (!match) return undefined;

  let remainder = match[1]?.trim() ?? "";
  let folder: string | undefined;
  const folderMatch = remainder.match(/(?:^|\s)--folder(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/u);

  if (folderMatch?.index !== undefined) {
    folder = folderMatch[1] ?? folderMatch[2] ?? folderMatch[3] ?? "";
    remainder =
      `${remainder.slice(0, folderMatch.index)} ${remainder.slice(folderMatch.index + folderMatch[0].length)}`.trim();
  }
  return { title: unquote(remainder), folder };
}

async function selectNotes(
  vault: HubbleVault,
  query: string,
  searchContents: boolean
): Promise<ResultType<HubblePath[], HubbleError>> {
  const files = await listMarkdownFiles(vault);
  if (Result.isError(files)) return files;

  if (!query || !searchContents) {
    return Result.ok(query ? fuzzyFilter(files.value, query, (file) => file.relative) : files.value);
  }

  const normalizedQuery = query.toLowerCase();
  const matches: HubblePath[] = [];

  for (const file of files.value) {
    const content = await readVaultFile(file);
    if (Result.isError(content)) return content;
    if (content.value.toLowerCase().includes(normalizedQuery)) matches.push(file);
  }

  return Result.ok(matches);
}

async function handleNewNote(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  getRoot: GetRoot
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/hubble new requires interactive UI mode.", "warning");
    return;
  }

  const parsed = parseNewCommand(args);
  if (!parsed) return;

  let title = parsed.title.trim();
  if (!title) {
    const enteredTitle = await ctx.ui.input("Hubble note title", "Leave blank to let the agent choose");
    if (enteredTitle === undefined) return;
    title = enteredTitle.trim();
  }

  let folder = parsed.folder;
  if (folder === undefined) {
    const enteredFolder = await ctx.ui.input("Hubble folder", "Optional vault-relative folder; blank for vault root");
    if (enteredFolder === undefined) return;
    folder = enteredFolder.trim();
  }

  if (!title) {
    if (!ctx.isIdle()) {
      ctx.ui.notify("The agent is busy. Try /hubble new again when it is idle.", "warning");
      return;
    }

    const folderInstruction = folder
      ? ` Use the vault-relative folder ${JSON.stringify(folder)}.`
      : " Use the vault root.";
    pi.sendUserMessage(
      `Create a new Hubble note for the current conversation. Choose a concise, useful title yourself and write a clear Markdown body summarizing the relevant investigation.${folderInstruction} Use hubble_create, do not overwrite an existing note, and report the created path when finished.`
    );
    ctx.ui.notify("Asked the agent to create a Hubble note and choose its title.", "info");
    return;
  }

  const vault = await getVault(getRoot, ctx);
  if (Result.isError(vault)) {
    ctx.ui.notify(errorMessage(vault.error), "error");
    return;
  }

  const result = await writeNewVaultFile(vault.value, title, "", folder);
  if (Result.isError(result)) {
    ctx.ui.notify(errorMessage(result.error), "error");
    return;
  }

  appendEditorAttachment(ctx, result.value.absolute);
  ctx.ui.notify(`Created Hubble note: ${result.value.relative}`, "info");
}

export function registerHubbleCommand(pi: ExtensionAPI, getRoot: GetRoot): void {
  pi.registerCommand("hubble", {
    description: "Browse and attach a Markdown note from the Hubble vault",
    getArgumentCompletions(prefix) {
      const items: AutocompleteItem[] = [
        { value: "new", label: "new", description: "Create a new Hubble note" },
        { value: "search", label: "search", description: "Search note contents" },
        { value: "open", label: "open", description: "Browse note filenames" },
      ];
      const filtered = fuzzyFilter(items, prefix, (item) => item.value);
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/hubble requires interactive UI mode.", "warning");
        return;
      }

      if (parseNewCommand(args)) {
        await handleNewNote(args, ctx, pi, getRoot);
        return;
      }

      const { query, searchContents } = parseHubbleCommand(args);
      const vault = await getVault(getRoot, ctx);
      if (Result.isError(vault)) {
        ctx.ui.notify(errorMessage(vault.error), "error");
        return;
      }

      const notes = await selectNotes(vault.value, query, searchContents);
      if (Result.isError(notes)) {
        ctx.ui.notify(errorMessage(notes.error), "error");
        return;
      }

      if (notes.value.length === 0) {
        ctx.ui.notify(query ? `No Hubble notes matched: ${query}` : "The Hubble vault has no Markdown notes.", "info");
        return;
      }

      const selected = await ctx.ui.custom<HubblePath | undefined>(
        (tui, theme, keybindings, done) =>
          new HubbleNotePicker(tui, theme, keybindings, notes.value, searchContents ? "" : query, done)
      );
      if (selected) {
        appendEditorAttachment(ctx, selected.absolute);
        ctx.ui.notify(`Attached Hubble note: ${selected.relative}`, "info");
      }
    },
  });
}
