import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, fuzzyFilter } from "@earendil-works/pi-tui";
import { Result, type Result as ResultType } from "better-result";
import type { GetVault } from "./hubble-config.ts";
import type { HubbleFailure } from "./hubble-errors.ts";
import { attachmentValue, HubbleNotePicker } from "./hubble-ui.ts";
import type { NoteReference, Vault } from "./hubble-vault.ts";

function appendEditorAttachment(
  ctx: { ui: { getEditorText(): string; setEditorText(text: string): void } },
  path: string
): void {
  const current = ctx.ui.getEditorText().trimEnd();
  ctx.ui.setEditorText(`${current}${current ? " " : ""}${attachmentValue(path)}`);
}

interface HubbleCommandSelection {
  query: string;
  searchContents: boolean;
}

function parseHubbleCommand(args: string): HubbleCommandSelection {
  const trimmed = args.trim();
  const searchMatch = trimmed.match(/^search(?:\s+(.+))?$/iu);
  if (searchMatch) return { query: searchMatch[1]?.trim() ?? "", searchContents: true };

  const findMatch = trimmed.match(/^find(?:\s+(.+))?$/iu);
  if (findMatch) return { query: findMatch[1]?.trim() ?? "", searchContents: false };

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

function parseNewCommand(args: string): { title: string; folder?: string } | undefined {
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
  vault: Vault,
  query: string,
  searchContents: boolean
): Promise<ResultType<NoteReference[], HubbleFailure>> {
  if (searchContents) {
    const results = await vault.search(query);
    if (Result.isError(results)) return results;
    return Result.ok(results.value.map((result) => result.note));
  }

  const files = await vault.list();
  if (Result.isError(files)) return files;

  return Result.ok(query ? fuzzyFilter(files.value, query, (file) => file.relative) : files.value);
}

async function handleNewNote(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  getVault: GetVault
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

  const vault = await getVault(ctx);
  if (Result.isError(vault)) {
    ctx.ui.notify(vault.error.message, "error");
    return;
  }

  const created = await vault.value.create(title, "", folder);
  if (Result.isError(created)) {
    ctx.ui.notify(created.error.message, "error");
    return;
  }

  appendEditorAttachment(ctx, created.value.absolute);
  ctx.ui.notify(`Created Hubble note: ${created.value.relative}`, "info");
}

export function registerHubbleCommand(pi: ExtensionAPI, getVault: GetVault): void {
  pi.registerCommand("hubble", {
    description: "Find and attach a Markdown note from the Hubble vault",
    getArgumentCompletions(prefix) {
      const items: AutocompleteItem[] = [
        { value: "new", label: "new", description: "Create a new Hubble note" },
        { value: "find", label: "find", description: "Find note filenames" },
        { value: "search", label: "search", description: "Search note contents" },
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
        await handleNewNote(args, ctx, pi, getVault);
        return;
      }

      const { query, searchContents } = parseHubbleCommand(args);
      const vault = await getVault(ctx);
      if (Result.isError(vault)) {
        ctx.ui.notify(vault.error.message, "error");
        return;
      }

      const notes = await selectNotes(vault.value, query, searchContents);
      if (Result.isError(notes)) {
        ctx.ui.notify(notes.error.message, "error");
        return;
      }

      if (notes.value.length === 0) {
        ctx.ui.notify(query ? `No Hubble notes matched: ${query}` : "The Hubble vault has no Markdown notes.", "info");
        return;
      }

      const selected = await ctx.ui.custom<NoteReference | undefined>(
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
